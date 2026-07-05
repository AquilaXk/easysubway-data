#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    if (flag === "--plan" || flag === "--summary" || flag === "--collect") {
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

function validateTagoScheduleSample(rawText) {
  const payload = JSON.parse(rawText);
  rejectCredentialLeak(rawText, payload);
  if (payload.response?.header && payload.response.header.resultCode !== "00") {
    throw new Error(`TAGO response is not normal service: ${payload.response?.header?.resultCode ?? "missing"}`);
  }

  const rows = normalizeRows(payload.response?.body?.items?.item);
  if (rows.length === 0) {
    throw new Error("TAGO schedule sample has no rows");
  }
  const observedFields = new Set(rows.flatMap((row) => Object.keys(row)));
  for (const field of OBSERVED_FIELDS) {
    if (!observedFields.has(field)) {
      throw new Error(`TAGO schedule sample missing observed field: ${field}`);
    }
  }

  let previousDeparture = -1;
  const providerRecordHashes = [];
  const departures = [];
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
    const arrivalSeconds = parseHhmmss(row.arrTime, `row ${index} arrTime`);
    const departureSeconds = parseHhmmss(row.depTime, `row ${index} depTime`);
    if (arrivalSeconds > departureSeconds) {
      throw new Error(`TAGO schedule row ${index} arrival must be <= departure`);
    }
    if (departureSeconds < previousDeparture) {
      throw new Error(`TAGO schedule rows must be sorted by depTime`);
    }
    previousDeparture = departureSeconds;
    providerRecordHashes.push(sha256(JSON.stringify(sortObject(row))));
    departures.push({
      subwayStationId: row.subwayStationId,
      subwayRouteId: row.subwayRouteId,
      dailyTypeCode: row.dailyTypeCode,
      upDownTypeCode: row.upDownTypeCode,
      arrivalSeconds,
      departureSeconds,
    });
  }

  return {
    artifactKind: "tago-schedule-sample-importer-validation",
    candidateId: "molit-tago-subway-info",
    endpoint: TAGO_SCHEDULE_ENDPOINT,
    rowCount: rows.length,
    providerRecordHashes,
    rawSha256: sha256(rawText),
    departures,
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
  if (!Array.isArray(responses) || responses.length === 0) {
    throw new Error("responses must be a non-empty array");
  }
  const checkpointRequestKeys = collection?.checkpoint?.completedRequestKeys ?? [];
  for (const requestKey of checkpointRequestKeys) {
    requestKeyParts(requestKey);
  }
  const responseRequestKeys = [];
  const rawSha256ByRequest = {};
  const providerRecordHashes = [];
  let rowCount = 0;

  for (const response of responses) {
    requestKeyParts(response.requestKey);
  }
  for (const response of [...responses].sort((left, right) => left.requestKey.localeCompare(right.requestKey))) {
    if (responseRequestKeys.includes(response.requestKey)) {
      throw new Error(`duplicate requestKey: ${response.requestKey}`);
    }
    if (typeof response.rawText !== "string" || response.rawText.length === 0) {
      throw new Error(`responses.rawText is required: ${response.requestKey}`);
    }
    const validation = validateTagoScheduleSample(response.rawText);
    assertResponseMatchesRequestKey(validation, response.requestKey);
    responseRequestKeys.push(response.requestKey);
    rawSha256ByRequest[response.requestKey] = validation.rawSha256;
    providerRecordHashes.push(...validation.providerRecordHashes);
    rowCount += validation.rowCount;
  }
  const completedRequestKeys = [...new Set([...checkpointRequestKeys, ...responseRequestKeys])].sort(
    (left, right) => left.localeCompare(right),
  );

  const evidencePayload = {
    sourceId: "molit-tago-subway-info",
    endpoint: TAGO_SCHEDULE_ENDPOINT,
    completedRequestKeys,
    responseRequestKeys,
    rawSha256ByRequest,
    providerRecordHashes,
  };
  return {
    artifactKind: "tago-schedule-collection-summary",
    sourceId: evidencePayload.sourceId,
    endpoint: evidencePayload.endpoint,
    completedRequestKeys,
    responseRequestKeys,
    checkpoint: { completedRequestKeys },
    responseCount: responseRequestKeys.length,
    rowCount,
    rawSha256ByRequest,
    providerRecordHashes,
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
      const validation = validateTagoScheduleSample(rawText);
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

function buildTagoScheduleCollectionArtifact(plan, options, collectedAt, responses, failure = {}) {
  const checkpoint = options.checkpoint ?? {};
  const failedRequestCount = failure.failedRequestKey ? 1 : 0;
  const completedRequestKeys = [
    ...new Set([...(checkpoint.completedRequestKeys ?? []), ...responses.map((response) => response.requestKey)]),
  ].sort((left, right) => left.localeCompare(right));
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
    if (!row.stationCode) continue;
    // TODO: pilot line 4 mapping only; replace with explicit provider station ids before nationwide collection.
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
    throw new Error("stationLineRows must contain at least one stationCode");
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
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
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
  console.log(JSON.stringify(result, null, 2));
}

async function writeJsonOutput(outputPath, value) {
  await writeFile(path.resolve(outputPath), `${JSON.stringify(value, null, 2)}\n`);
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
  collectTagoSchedules,
  validateTagoScheduleSample,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
