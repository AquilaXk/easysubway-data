#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { sanitizeErrorMessage } from "./lib/source-candidate-evidence-collector.mjs";

const FARE_ENDPOINT = "https://apis.data.go.kr/B553766/fare2/getRltmFare2";
const MAX_ATTEMPTS = 2;
const REQUIRED_FARE_FIELDS = Object.freeze([
  "gnrlCardFare",
  "gnrlCashFare",
  "yungCardFare",
  "yungCashFare",
  "childCardFare",
  "childCashFare",
]);
const EXPECTED_SAMPLE = Object.freeze({
  dptreStnCd: "0150",
  dptreStnNm: "서울역",
  arvlStnCd: "0151",
  arvlStnNm: "시청",
  gnrlCardFare: 1550,
  gnrlCashFare: 1650,
  yungCardFare: 900,
  yungCashFare: 1650,
  childCardFare: 550,
  childCashFare: 550,
});
const CANARY_ORIGIN = Object.freeze({ stationName: "서울역" });
const CANARY_DESTINATION = Object.freeze({ stationName: "시청" });
const CANARY_INTERNAL = Object.freeze({
  origin: { stationId: "station-2af75c3d707b", lineId: "seoul-4", stationName: "서울역" },
  destination: { stationId: "station-a2d54a5d63d2", lineId: "line-472a81add377", stationName: "시청" },
});
const TARGETS = Object.freeze([
  { stationId: "station-sangnoksu", lineId: "seoul-4", stationName: "상록수" },
  { stationId: "station-sadang", lineId: "seoul-4", stationName: "사당" },
]);

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function decodedServiceKey(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sleep(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function validateFareSample(sample) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    throw new TypeError("fare API sample must be an object");
  }
  for (const [field, expected] of Object.entries(EXPECTED_SAMPLE)) {
    if (!(field in sample)) throw new Error(`fare API field missing: ${field}`);
    if (typeof sample[field] !== typeof expected) throw new TypeError(`fare API field type invalid: ${field}`);
    if (sample[field] !== expected) throw new Error(`fare API field value changed: ${field}`);
  }
}

export function sanitizeProbeError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    const original = secret ?? "";
    for (const variant of new Set([original, decodedServiceKey(original)])) {
      message = sanitizeErrorMessage(message, variant);
    }
  }
  return message;
}

function shouldRetryStatus(status) {
  return status === 429 || status >= 500;
}

async function fetchJsonWithRetry({ fetchImpl, url, timeoutMs, retryDelayMs, label }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs);
        continue;
      }
      throw error;
    }
    if (!response.ok && attempt < MAX_ATTEMPTS && shouldRetryStatus(response.status)) {
      await sleep(retryDelayMs);
      continue;
    }
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    try {
      return { attempts: attempt, payload: await response.json() };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${label} returned invalid JSON`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${label} retry exhausted`);
}

function fareUrl({ fareServiceKey, origin, destination }) {
  const url = new URL(FARE_ENDPOINT);
  url.searchParams.set("serviceKey", decodedServiceKey(fareServiceKey));
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "10");
  url.searchParams.set("dataType", "JSON");
  url.searchParams.set("dptreStnNm", origin.stationName);
  url.searchParams.set("arvlStnNm", destination.stationName);
  return url;
}

function responseItems(payload, label) {
  const envelope = payload?.response ?? payload;
  const resultCode = String(envelope?.header?.resultCode ?? "");
  const body = envelope?.body;
  const rawItems = body?.items?.item ?? body?.items ?? body?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  if (resultCode !== "00") throw new Error(`${label} response rejected: resultCode=${resultCode || "missing"}`);
  if (!Number.isSafeInteger(body?.totalCount) || body.totalCount !== items.length) {
    throw new Error(`${label} response pagination is incomplete`);
  }
  return items;
}

function validatedFareItem(items, origin, destination) {
  const matching = items.filter((item) => item && typeof item === "object" && !Array.isArray(item)
    && item.dptreStnNm === origin.stationName
    && item.arvlStnNm === destination.stationName);
  if (matching.length !== 1) throw new Error("fare API response mapping is absent or ambiguous");
  const item = matching[0];
  if (typeof item.dptreStnCd !== "string" || !/^\d{4}$/.test(item.dptreStnCd)
    || typeof item.arvlStnCd !== "string" || !/^\d{4}$/.test(item.arvlStnCd)
    || item.dptreStnCd === item.arvlStnCd) {
    throw new Error("fare API station code mapping is invalid");
  }
  const fares = {};
  for (const field of REQUIRED_FARE_FIELDS) {
    const value = item[field];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`fare API field invalid: ${field}`);
    fares[field] = value;
  }
  return { destinationCode: item.arvlStnCd, fares, originCode: item.dptreStnCd };
}

async function fetchFareQuote({ destination, fareServiceKey, fetchImpl, origin, retryDelayMs, timeoutMs }) {
  const { attempts, payload } = await fetchJsonWithRetry({
    fetchImpl,
    url: fareUrl({ fareServiceKey, origin, destination }),
    timeoutMs,
    retryDelayMs,
    label: "fare API",
  });
  return { attempts, ...validatedFareItem(responseItems(payload, "fare API"), origin, destination) };
}

export async function probeOfficialOdFares({
  fareServiceKey,
  outputPath,
  fetchImpl = fetch,
  retryDelayMs = 250,
  timeoutMs = 30_000,
} = {}) {
  let temporaryOutputPath;
  try {
    if (!path.isAbsolute(requiredText(outputPath, "FARE_API_PROBE_OUTPUT"))) {
      throw new Error("FARE_API_PROBE_OUTPUT must be an absolute path");
    }
    await rm(outputPath, { force: true });
    requiredText(fareServiceKey, "DATA_GO_KR_SERVICE_KEY");

    const canary = await fetchFareQuote({
      destination: CANARY_DESTINATION,
      fareServiceKey,
      fetchImpl,
      origin: CANARY_ORIGIN,
      retryDelayMs,
      timeoutMs,
    });
    validateFareSample({
      dptreStnCd: canary.originCode,
      dptreStnNm: CANARY_ORIGIN.stationName,
      arvlStnCd: canary.destinationCode,
      arvlStnNm: CANARY_DESTINATION.stationName,
      ...canary.fares,
    });

    const directions = [[TARGETS[0], TARGETS[1]], [TARGETS[1], TARGETS[0]]];
    const quotes = [];
    const targetMappings = [];
    const attemptCounts = {};
    attemptCounts[`${CANARY_INTERNAL.origin.stationId}→${CANARY_INTERNAL.destination.stationId}`] = canary.attempts;
    for (const [origin, destination] of directions) {
      const { attempts, destinationCode, fares, originCode } = await fetchFareQuote({
        destination,
        fareServiceKey,
        fetchImpl,
        origin,
        retryDelayMs,
        timeoutMs,
      });
      const directionKey = `${origin.stationId}→${destination.stationId}`;
      attemptCounts[directionKey] = attempts;
      quotes.push({ originStationId: origin.stationId, destinationStationId: destination.stationId, fares });
      targetMappings.push({ destinationCode, originCode });
    }
    quotes.push({
      originStationId: CANARY_INTERNAL.origin.stationId,
      destinationStationId: CANARY_INTERNAL.destination.stationId,
      fares: canary.fares,
    });
    if (targetMappings[0].originCode !== targetMappings[1].destinationCode
      || targetMappings[0].destinationCode !== targetMappings[1].originCode) {
      throw new Error("fare API target station code equivalence failed");
    }

    const providerMappings = TARGETS.map((target, index) => ({
      stationId: target.stationId,
      lineId: target.lineId,
      stationName: target.stationName,
      fareStationCode: index === 0 ? targetMappings[0].originCode : targetMappings[0].destinationCode,
    })).concat([
      { ...CANARY_INTERNAL.origin, fareStationCode: canary.originCode },
      { ...CANARY_INTERNAL.destination, fareStationCode: canary.destinationCode },
    ]);
    const equivalence = {
      seoulStationLine4: { fareResponseStationCode: canary.originCode, fareCode: "0150", verified: true },
      cityHallLine1: { fareResponseStationCode: canary.destinationCode, fareCode: "0151", verified: true },
    };
    const evidence = {
      schemaVersion: 1,
      artifactKind: "official-od-fare-probe-evidence",
      mappingAvailability: "AVAILABLE",
      mappingField: "dptreStnCd/arvlStnCd",
      providerId: "data-go-kr-b553766-fare2",
      equivalence,
      providerMappings,
      quotes,
      fieldNames: [...REQUIRED_FARE_FIELDS].sort((left, right) =>
        left < right ? -1 : 1),
      attemptCounts,
    };
    temporaryOutputPath = `${outputPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryOutputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporaryOutputPath, 0o600);
    await rename(temporaryOutputPath, outputPath);
    temporaryOutputPath = undefined;
    return evidence;
  } catch (error) {
    if (temporaryOutputPath) await rm(temporaryOutputPath, { force: true }).catch(() => {});
    throw new Error(sanitizeProbeError(error, [fareServiceKey]));
  }
}

async function main() {
  const evidence = await probeOfficialOdFares({
    fareServiceKey: process.env.DATA_GO_KR_SERVICE_KEY,
    outputPath: process.env.FARE_API_PROBE_OUTPUT,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "fare API probe failed"}\n`);
    process.exitCode = 1;
  });
}
