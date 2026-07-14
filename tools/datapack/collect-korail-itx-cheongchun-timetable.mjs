#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cleanupPackDir, openPack } from "../route-map/pack-io.mjs";
import { reconstructTransitTrips } from "./reconstruct-transit-trips.mjs";

const API_ORIGIN = "https://apis.data.go.kr";
const DETAIL_URL = "https://www.data.go.kr/data/15125762/openapi.do";
const LINE_ID = "line-54a7b980b7c3";
const EXPECTED_FIELDS = Object.freeze({
  codes: Object.freeze(["code", "type", "value"]),
  plan: Object.freeze([
    "run_ymd", "trn_no", "dptre_stn_cd", "dptre_stn_nm", "arvl_stn_cd", "arvl_stn_nm",
    "trn_plan_dptre_dt", "trn_plan_arvl_dt",
  ]),
  info: Object.freeze([
    "run_ymd", "trn_no", "trn_run_sn", "stn_cd", "stn_nm", "mrnt_cd", "mrnt_nm",
    "uppln_dn_se_cd", "stop_se_cd", "stop_se_nm", "trn_dptre_dt", "trn_arvl_dt",
  ]),
});

export async function collectKorailItxCheongchunTimetable({
  serviceKey,
  runDate,
  kricServiceDayCode,
  packPath,
  trainNumberEvidence,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const key = decodedServiceKey(requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  if (!/^\d{8}$/.test(runDate ?? "")) throw new Error("runDate must be YYYYMMDD");
  if (!["7", "8", "9"].includes(kricServiceDayCode)) throw new Error("kricServiceDayCode must be 7, 8, or 9");
  requiredString(packPath, "packPath");
  validateTrainNumberEvidence(trainNumberEvidence, kricServiceDayCode);

  const codes = await fetchAll({
    endpoint: `${API_ORIGIN}/B551457/run/v2/codes2`,
    query: { "cond[type::EQ]": "mrnt_cd" },
    expectedFields: EXPECTED_FIELDS.codes,
    key,
    fetchImpl,
  });
  const routeCode = uniqueGyeongchunRouteCode(codes.rows);
  const stopCodes = await fetchAll({
    endpoint: `${API_ORIGIN}/B551457/run/v2/codes2`,
    query: { "cond[type::EQ]": "stop_se_cd" },
    expectedFields: EXPECTED_FIELDS.codes,
    key,
    fetchImpl,
  });
  const passengerStopCodes = passengerStopCodeMappings(stopCodes.rows);
  const commonQuery = {
    "cond[run_ymd::GTE]": runDate,
    "cond[run_ymd::LTE]": runDate,
  };
  const plans = await fetchAll({
    endpoint: `${API_ORIGIN}/B551457/run/v2/travelerTrainRunPlan2`,
    query: commonQuery,
    expectedFields: EXPECTED_FIELDS.plan,
    key,
    fetchImpl,
  });
  const info = await fetchAll({
    endpoint: `${API_ORIGIN}/B551457/run/v2/travelerTrainRunInfo2`,
    query: { ...commonQuery, "cond[mrnt_cd::EQ]": routeCode.code },
    expectedFields: EXPECTED_FIELDS.info,
    key,
    fetchImpl,
  });
  const materializationInput = {
    plans: plans.rows,
    infoRows: info.rows,
    runDate,
    kricServiceDayCode,
    packPath,
    trainNumbers: trainNumberEvidence.trainNumbers,
    routeCode: routeCode.code,
    passengerStopCodes,
  };
  const analyzed = analyzeKorailItxRows(materializationInput);
  const materialized = analyzed.missingTimestampStopCount === 0
    ? materializeAnalyzedKorailItxRows(analyzed, kricServiceDayCode, runDate)
    : { transitTrips: [], transitStopTimes: [], trainNumbers: analyzed.trainNumbers, stationMappings: analyzed.stationMappings };
  if (analyzed.missingTimestampStopCount === 0) {
    validateTagoOdJoin(materialized, trainNumberEvidence, kricServiceDayCode, runDate);
  }

  return {
    schemaVersion: 1,
    artifactKind: "korail-itx-cheongchun-station-sequence-evidence",
    serviceId: "ITX_CHEONGCHUN",
    canonicalLineId: LINE_ID,
    servicePattern: "EXPRESS",
    officialSourceUrl: DETAIL_URL,
    observedAt: now.toISOString(),
    runDate,
    kricServiceDayCode,
    providerResultCode: "0",
    schemaStatus: "EXPECTED",
    routeCodeMapping: { providerCode: routeCode.code, providerName: routeCode.value },
    stopCodeMappings: [...passengerStopCodes].map(([providerCode, providerName]) => ({ providerCode, providerName })),
    trainNumberFilter: {
      sourceArtifactKind: trainNumberEvidence.artifactKind,
      trainNumberCount: trainNumberEvidence.trainNumbers.length,
      evidenceHash: trainNumberEvidence.evidenceHash,
    },
    trainCount: analyzed.trainNumbers.length,
    stationSequenceRowCount: analyzed.stationSequences.reduce((total, trip) => total + trip.stops.length, 0),
    stopTimeCount: materialized.transitStopTimes.length,
    trainNumbers: analyzed.trainNumbers,
    stationMappings: analyzed.stationMappings,
    stationSequences: analyzed.stationSequences,
    materialization: {
      status: analyzed.missingTimestampStopCount === 0 ? "SUPPORTED" : "MISSING_STATION_TIMES",
      missingTimestampStopCount: analyzed.missingTimestampStopCount,
    },
    operations: [
      operationEvidence("codes2", codes),
      operationEvidence("codes2", stopCodes),
      operationEvidence("travelerTrainRunPlan2", plans),
      operationEvidence("travelerTrainRunInfo2", info),
    ],
    transitTrips: materialized.transitTrips,
    transitStopTimes: materialized.transitStopTimes,
    evidenceHash: sha256(JSON.stringify({
      runDate,
      kricServiceDayCode,
      trainNumberEvidenceHash: trainNumberEvidence.evidenceHash,
      stationMappings: analyzed.stationMappings,
      stationSequences: analyzed.stationSequences,
      plans: plans.rows,
      info: info.rows,
      transitTrips: materialized.transitTrips,
      transitStopTimes: materialized.transitStopTimes,
    })),
    credentialRedacted: true,
  };
}

export function materializeKorailItxRows({
  plans,
  infoRows,
  runDate,
  kricServiceDayCode,
  packPath,
  trainNumbers,
  routeCode,
  passengerStopCodes,
}) {
  const analyzed = analyzeKorailItxRows({
    plans,
    infoRows,
    runDate,
    kricServiceDayCode,
    packPath,
    trainNumbers,
    routeCode,
    passengerStopCodes,
  });
  return materializeAnalyzedKorailItxRows(analyzed, kricServiceDayCode, runDate);
}

export function analyzeKorailItxRows({
  plans,
  infoRows,
  runDate,
  packPath,
  trainNumbers,
  routeCode,
  passengerStopCodes,
}) {
  if (!Array.isArray(plans) || plans.length === 0) throw new Error("Korail run plan returned zero rows");
  if (!Array.isArray(infoRows) || infoRows.length === 0) throw new Error("Korail ITX run info returned zero rows");
  const planByTrain = uniqueRowsByTrain(plans, runDate, "run plan");
  const allowed = new Set((trainNumbers ?? []).map(normalizeTrainNumber));
  if (allowed.size === 0 || allowed.size !== trainNumbers.length) throw new Error("TAGO ITX train numbers must be non-empty and unique");
  if (!(passengerStopCodes instanceof Map) || passengerStopCodes.size === 0) {
    throw new Error("Korail passenger stop code mappings are required");
  }
  const canonical = readCanonicalLine(packPath);
  try {
    const grouped = groupKorailInfoRows({ infoRows, runDate, routeCode, allowed, planByTrain });
    const sequenceAnalysis = analyzeStationSequences({ grouped, canonical, passengerStopCodes });
    return {
      trainNumbers: [...grouped.keys()].sort(naturalCompare),
      stationMappings: [...sequenceAnalysis.stationMappings.values()].sort((left, right) => (
        left.lineSequence - right.lineSequence || naturalCompare(left.providerStationCode, right.providerStationCode)
      )),
      stationSequences: sequenceAnalysis.stationSequences,
      missingTimestampStopCount: sequenceAnalysis.missingTimestampStopCount,
      lineSequenceByStationLine: Object.fromEntries([...canonical.byName.values()].map((station) => [
        `${station.stationId}|${LINE_ID}`,
        station.lineSequence,
      ])),
    };
  } finally {
    canonical.close();
  }
}

function groupKorailInfoRows({ infoRows, runDate, routeCode, allowed, planByTrain }) {
  const grouped = new Map();
  for (const row of infoRows) {
    if (String(row.run_ymd) !== runDate) throw new Error("Korail ITX run info run date mismatch");
    if (normalize(row.mrnt_nm) !== normalize("경춘선") || String(row.mrnt_cd) !== routeCode) {
      throw new Error("Korail run info contains non-경춘선 row");
    }
    const trainNumber = normalizeTrainNumber(row.trn_no);
    if (!allowed.has(trainNumber)) continue;
    if (!planByTrain.has(trainNumber)) throw new Error(`Korail ITX run plan missing train: ${safeToken(trainNumber)}`);
    const rows = grouped.get(trainNumber) ?? [];
    rows.push(row);
    grouped.set(trainNumber, rows);
  }
  for (const trainNumber of allowed) {
    if (!grouped.has(trainNumber)) throw new Error(`Korail station rows missing TAGO ITX train: ${safeToken(trainNumber)}`);
  }
  return grouped;
}

function analyzeStationSequences({ grouped, canonical, passengerStopCodes }) {
  const stationMappings = new Map();
  const stationSequences = [];
  let missingTimestampStopCount = 0;
  for (const [trainNumber, trainRows] of [...grouped.entries()].sort(([left], [right]) => naturalCompare(left, right))) {
    const ordered = orderedTrainRows(trainRows, trainNumber);
    const selected = selectPassengerStops({ ordered, canonical, passengerStopCodes, stationMappings, trainNumber });
    validateCanonicalTrip(selected.stops, ordered, trainNumber);
    missingTimestampStopCount += selected.missingTimestampStopCount;
    stationSequences.push({ trainNumber, stops: selected.stops });
  }
  return { stationMappings, stationSequences, missingTimestampStopCount };
}

function orderedTrainRows(trainRows, trainNumber) {
  const ordered = trainRows
    .map((row) => ({ row, sequence: positiveInteger(row.trn_run_sn, "trn_run_sn") }))
    .sort((left, right) => left.sequence - right.sequence);
  if (new Set(ordered.map(({ sequence }) => sequence)).size !== ordered.length) {
    throw new Error(`Korail ITX duplicate trn_run_sn: ${safeToken(trainNumber)}`);
  }
  return ordered;
}

function selectPassengerStops({ ordered, canonical, passengerStopCodes, stationMappings, trainNumber }) {
  const stops = [];
  let missingTimestampStopCount = 0;
  const passengerRows = ordered.flatMap(({ row, sequence }, index) => {
    const stopCode = String(row.stop_se_cd);
    const expectedStopName = passengerStopCodes.get(stopCode);
    if (!expectedStopName) return [];
    if (normalize(expectedStopName) !== normalize(row.stop_se_nm)) {
      throw new Error(`Korail ITX passenger stop name mismatch: ${safeToken(trainNumber)}/${safeLabel(row.stn_nm)}`);
    }
    const station = canonical.byName.get(normalizeStationName(row.stn_nm));
    return [{ row, sequence, index, station, stopCode }];
  });
  const canonicalIndexes = passengerRows.filter(({ station }) => station).map(({ index }) => index);
  const firstCanonicalIndex = Math.min(...canonicalIndexes);
  const lastCanonicalIndex = Math.max(...canonicalIndexes);
  for (const { row, sequence, index, station, stopCode } of passengerRows) {
    if (!station && index > firstCanonicalIndex && index < lastCanonicalIndex) {
      throw new Error(`Korail ITX passenger stop canonical mapping missing: ${safeToken(trainNumber)}/${safeLabel(row.stn_nm)}`);
    }
    if (!station) continue;
    const arrivalTimestamp = validProviderTimestamp(row.trn_arvl_dt);
    const departureTimestamp = validProviderTimestamp(row.trn_dptre_dt);
    if (arrivalTimestamp === null && departureTimestamp === null) missingTimestampStopCount += 1;
    stationMappings.set(`${row.stn_cd}|${station.stationId}`, {
      providerStationCode: String(row.stn_cd),
      providerStationName: String(row.stn_nm),
      canonicalStationId: station.stationId,
      lineSequence: station.lineSequence,
    });
    stops.push({
      providerSequence: sequence,
      providerStationCode: String(row.stn_cd),
      providerStationName: String(row.stn_nm),
      canonicalStationId: station.stationId,
      lineSequence: station.lineSequence,
      stopCode,
      stopName: String(row.stop_se_nm),
      arrivalTimestamp,
      departureTimestamp,
    });
  }
  return { stops, missingTimestampStopCount };
}

function validateCanonicalTrip(stops, ordered, trainNumber) {
  if (stops.length < 2) {
    const observed = ordered.slice(0, 30).map(({ row }) => (
      `${safeLabel(row.stn_nm)}:${safeLabel(row.stop_se_cd)}:${safeLabel(row.stop_se_nm)}`
    ));
    throw new Error(
      `Korail ITX trip must have at least 2 canonical stops: ${safeToken(trainNumber)}; observed=${observed.join(",")}`,
    );
  }
  const stationIds = stops.map(({ canonicalStationId }) => canonicalStationId);
  if (new Set(stationIds).size !== stationIds.length) {
    throw new Error(`Korail ITX duplicate canonical stop: ${safeToken(trainNumber)}`);
  }
  for (const endpoint of ["station-b819702fa7d9", "station-dd14cfb89cbc"]) {
    if (!stationIds.includes(endpoint)) throw new Error(`Korail ITX canonical endpoint missing: ${safeToken(trainNumber)}`);
  }
  validateLineSequenceOnly(stops, trainNumber);
}

function materializeAnalyzedKorailItxRows(analyzed, kricServiceDayCode, runDate) {
  const intermediate = [];
  for (const trip of analyzed.stationSequences) {
    const rows = trip.stops.map((stop) => {
      const timestampContext = `${safeToken(trip.trainNumber)}/${safeLabel(stop.providerStationName)}/${safeLabel(stop.stopCode)}`;
      const arrivalSeconds = timestampSeconds(
        providerTimestamp(stop.arrivalTimestamp, stop.departureTimestamp, `trn_arvl_dt[${timestampContext}]`),
        runDate,
        `trn_arvl_dt[${timestampContext}]`,
      );
      const departureSeconds = timestampSeconds(
        providerTimestamp(stop.departureTimestamp, stop.arrivalTimestamp, `trn_dptre_dt[${timestampContext}]`),
        runDate,
        `trn_dptre_dt[${timestampContext}]`,
      );
      if (arrivalSeconds > departureSeconds) throw new Error(`Korail ITX arrival must precede departure: ${safeToken(trip.trainNumber)}`);
      return {
        stationId: stop.canonicalStationId,
        lineId: LINE_ID,
        trnNo: trip.trainNumber,
        dayCd: kricServiceDayCode,
        arrivalSeconds,
        departureSeconds,
        servicePattern: "EXPRESS",
        lineSequence: stop.lineSequence,
      };
    });
    validateProviderOrder(rows, trip.trainNumber);
    intermediate.push(...rows.map(({ lineSequence: _lineSequence, ...row }) => row));
  }
  const context = {
    lineSequenceByStationLine: analyzed.lineSequenceByStationLine,
    routeIdByLineDirection: {
      [`${LINE_ID}|up`]: `route-${LINE_ID}-up`,
      [`${LINE_ID}|down`]: `route-${LINE_ID}-down`,
    },
    serviceIdByDayCd: { "8": "weekday-kric", "7": "saturday-kric", "9": "holiday-kric" },
  };
  return {
    ...reconstructTransitTrips(intermediate, context),
    trainNumbers: analyzed.trainNumbers,
    stationMappings: analyzed.stationMappings,
  };
}

function uniqueGyeongchunRouteCode(rows) {
  const matches = rows.filter((row) => row.type === "mrnt_cd" && normalize(row.value) === normalize("경춘선"));
  if (matches.length !== 1) throw new Error("Korail mrnt_cd 경춘선 mapping is missing or ambiguous");
  return {
    code: requiredString(String(matches[0].code), "mrnt_cd.code"),
    value: requiredString(String(matches[0].value), "mrnt_cd.value"),
  };
}

function passengerStopCodeMappings(rows) {
  const allowed = new Set([normalize("시발"), normalize("여객승하차"), normalize("종착")]);
  const matches = rows.filter((row) => row.type === "stop_se_cd" && allowed.has(normalize(row.value)));
  if (matches.length === 0) throw new Error("Korail passenger stop code mapping is missing");
  return new Map(matches.map((row) => [
    requiredString(String(row.code), "stop_se_cd.code"),
    requiredString(String(row.value), "stop_se_cd.value"),
  ]));
}

function validateTrainNumberEvidence(evidence, kricServiceDayCode) {
  if (evidence?.artifactKind !== "tago-itx-cheongchun-od-evidence" || evidence?.serviceId !== "ITX_CHEONGCHUN") {
    throw new Error("TAGO ITX train number evidence is invalid");
  }
  if (evidence.kricServiceDayCode !== kricServiceDayCode) throw new Error("TAGO/Korail service day code mismatch");
  if (!Array.isArray(evidence.trainNumbers) || !Array.isArray(evidence.itineraries)
    || evidence.trainNumbers.length === 0 || evidence.trainNumbers.length !== evidence.itineraries.length) {
    throw new Error("TAGO ITX train number evidence is incomplete");
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.evidenceHash ?? "")) throw new Error("TAGO ITX evidenceHash is invalid");
}

function validateTagoOdJoin(materialized, evidence, dayCd, runDate) {
  const departureStationId = evidence?.departureStation?.canonicalStationId;
  const arrivalStationId = evidence?.arrivalStation?.canonicalStationId;
  if (typeof departureStationId !== "string" || typeof arrivalStationId !== "string") {
    throw new Error("TAGO ITX canonical endpoint mappings are required");
  }
  if (evidence.departureDate !== isoRunDate(runDate)) throw new Error("Korail/TAGO ITX service date mismatch");
  const tripsByNumber = new Map(materialized.trainNumbers.map((trainNumber) => [
    trainNumber,
    materialized.transitTrips.find(({ id }) => id.endsWith(`-${trainNumber}-${dayCd}`)),
  ]));
  for (const [index, itinerary] of evidence.itineraries.entries()) {
    const trainNumber = normalizeTrainNumber(itinerary.trainNumber);
    const trip = tripsByNumber.get(trainNumber);
    if (!trip) throw new Error(`Korail trip missing TAGO ITX train: ${safeToken(trainNumber)}`);
    const stops = materialized.transitStopTimes.filter(({ tripId }) => tripId === trip.id);
    const departure = stops.filter(({ stationId }) => stationId === departureStationId);
    const arrival = stops.filter(({ stationId }) => stationId === arrivalStationId);
    if (departure.length !== 1 || arrival.length !== 1) throw new Error(`Korail ITX canonical endpoint mismatch: ${safeToken(trainNumber)}`);
    if (departure[0].departureSeconds !== isoServiceSeconds(itinerary.departureAt, runDate, `itineraries[${index}].departureAt`)
      || arrival[0].arrivalSeconds !== isoServiceSeconds(itinerary.arrivalAt, runDate, `itineraries[${index}].arrivalAt`)) {
      throw new Error(`Korail/TAGO ITX endpoint time mismatch: ${safeToken(trainNumber)}`);
    }
  }
}

function isoServiceSeconds(value, runDate, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+09:00$/.exec(String(value ?? ""));
  if (!match) throw new Error(`${label} must use Asia/Seoul ISO timestamp`);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error(`${label} is invalid`);
  const timestampDate = `${match[1]}${match[2]}${match[3]}`;
  return serviceDateOffsetSeconds(timestampDate, runDate, label) + hours * 3600 + minutes * 60 + seconds;
}

function readCanonicalLine(packPath) {
  const opened = openPack(packPath, "korail-itx-canonical-");
  try {
    const rows = opened.db.prepare(`
      SELECT stations.id, stations.name_ko, station_lines.line_sequence
      FROM station_lines
      JOIN stations ON stations.id = station_lines.station_id
      WHERE station_lines.line_id = ?
      ORDER BY station_lines.line_sequence, stations.id
    `).all(LINE_ID);
    if (rows.length === 0) throw new Error(`canonical pack has no line: ${LINE_ID}`);
    const byName = new Map();
    for (const row of rows) {
      const name = normalizeStationName(row.name_ko);
      if (byName.has(name)) throw new Error(`canonical line has duplicate station name: ${name}`);
      byName.set(name, { stationId: row.id, lineSequence: row.line_sequence });
    }
    return {
      byName,
      close() {
        opened.db.close();
        cleanupPackDir(opened.dir);
      },
    };
  } catch (error) {
    opened.db.close();
    cleanupPackDir(opened.dir);
    throw error;
  }
}

function uniqueRowsByTrain(rows, runDate, label) {
  const result = new Map();
  for (const row of rows) {
    if (String(row.run_ymd) !== runDate) throw new Error(`Korail ${label} run date mismatch`);
    const trainNumber = normalizeTrainNumber(row.trn_no);
    if (result.has(trainNumber)) throw new Error(`Korail ${label} duplicate train: ${safeToken(trainNumber)}`);
    result.set(trainNumber, row);
  }
  return result;
}

function validateProviderOrder(rows, trainNumber) {
  let direction = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1].departureSeconds > rows[index].arrivalSeconds) {
      throw new Error(`Korail ITX stop time is not monotonic: ${safeToken(trainNumber)}`);
    }
    const step = Math.sign(rows[index].lineSequence - rows[index - 1].lineSequence);
    if (step === 0 || (direction !== 0 && step !== direction)) {
      throw new Error(`Korail ITX stop order must follow canonical lineSequence: ${safeToken(trainNumber)}`);
    }
    direction ||= step;
  }
}

function validateLineSequenceOnly(rows, trainNumber) {
  let direction = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const step = Math.sign(rows[index].lineSequence - rows[index - 1].lineSequence);
    if (step === 0 || (direction !== 0 && step !== direction)) {
      throw new Error(`Korail ITX stop order must follow canonical lineSequence: ${safeToken(trainNumber)}`);
    }
    direction ||= step;
  }
}

async function fetchAll({ endpoint, query, expectedFields, key, fetchImpl }) {
  const rows = [];
  const hashes = [];
  let totalCount = null;
  for (let pageNo = 1; pageNo <= 100; pageNo += 1) {
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries({
      serviceKey: key,
      pageNo: String(pageNo),
      numOfRows: "1000",
      returnType: "JSON",
      ...query,
    })) url.searchParams.set(name, value);
    const response = await fetchWithRetry(url, fetchImpl);
    if (!response.ok) throw new Error(`Korail train operation API HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (contentType !== "application/json") throw new Error(`Korail train operation API schema mismatch: content-type ${safeToken(contentType)}`);
    const raw = await response.text();
    hashes.push(sha256(raw));
    const page = parsePage(raw, expectedFields);
    totalCount ??= page.totalCount;
    if (totalCount !== page.totalCount) throw new Error("Korail train operation API schema mismatch: totalCount changed");
    rows.push(...page.rows);
    if (rows.length >= totalCount) break;
    if (page.rows.length === 0) throw new Error("Korail train operation API pagination incomplete");
  }
  if (rows.length !== totalCount || rows.length === 0) {
    const operation = new URL(endpoint).pathname.split("/").at(-1);
    throw new Error(
      `Korail train operation API pagination incomplete: operation=${safeToken(operation)},` +
      `collected=${rows.length},total=${totalCount ?? "UNKNOWN"},pages=${hashes.length}`,
    );
  }
  return { endpoint, rows, pageCount: hashes.length, totalCount, rawResponseSha256: sha256(hashes.join("|")) };
}

function parsePage(raw, expectedFields) {
  let document;
  try { document = JSON.parse(raw); } catch { throw new Error("Korail train operation API schema mismatch: invalid JSON"); }
  const code = safeToken(document?.response?.header?.resultCode);
  if (code !== "0") throw new Error(`Korail train operation API provider resultCode ${code}`);
  const body = document?.response?.body;
  const item = body?.items?.item;
  const rows = item == null ? [] : Array.isArray(item) ? item : [item];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Korail train operation API schema mismatch: item[${index}]`);
    const missing = expectedFields.filter((field) => !Object.hasOwn(row, field));
    if (missing.length > 0) throw new Error(`Korail train operation API schema mismatch: item[${index}] fields missing=${missing.join(",")}`);
  }
  const totalCount = Number(body?.totalCount);
  if (!Number.isInteger(totalCount) || totalCount < rows.length) throw new Error("Korail train operation API schema mismatch: totalCount");
  return { rows, totalCount };
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
    } catch (error) {
      if (attempt === 1) throw new Error("Korail train operation API transport failure", { cause: error });
    }
  }
  throw new Error("Korail train operation API transport failure");
}

function timestampSeconds(value, runDate, label) {
  const text = requiredString(String(value), label);
  if (!/^\d{14}$/.test(text)) throw new Error(`${label} must use YYYYMMDDHHMISS`);
  const hours = Number(text.slice(8, 10));
  const minutes = Number(text.slice(10, 12));
  const seconds = Number(text.slice(12, 14));
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error(`${label} is invalid`);
  return serviceDateOffsetSeconds(text.slice(0, 8), runDate, label) + hours * 3600 + minutes * 60 + seconds;
}

function serviceDateOffsetSeconds(timestampDate, runDate, label) {
  if (timestampDate === runDate) return 0;
  if (timestampDate === nextRunDate(runDate)) return 86_400;
  throw new Error(`${label} must use runDate or the immediately following date`);
}

function nextRunDate(runDate) {
  if (!/^\d{8}$/.test(runDate)) throw new Error("runDate must be YYYYMMDD");
  const year = Number(runDate.slice(0, 4));
  const month = Number(runDate.slice(4, 6));
  const day = Number(runDate.slice(6, 8));
  const current = new Date(Date.UTC(year, month - 1, day));
  if (`${current.getUTCFullYear()}${String(current.getUTCMonth() + 1).padStart(2, "0")}${String(current.getUTCDate()).padStart(2, "0")}` !== runDate) {
    throw new Error("runDate must be a valid calendar date");
  }
  current.setUTCDate(current.getUTCDate() + 1);
  return `${current.getUTCFullYear()}${String(current.getUTCMonth() + 1).padStart(2, "0")}${String(current.getUTCDate()).padStart(2, "0")}`;
}

function isoRunDate(runDate) {
  nextRunDate(runDate);
  return `${runDate.slice(0, 4)}-${runDate.slice(4, 6)}-${runDate.slice(6, 8)}`;
}

function providerTimestamp(primary, fallback, label) {
  for (const value of [primary, fallback]) {
    const text = String(value ?? "");
    if (/^\d{14}$/.test(text)) return text;
  }
  throw new Error(`${label} and fallback timestamp are missing`);
}

function validProviderTimestamp(value) {
  const text = String(value ?? "");
  return /^\d{14}$/.test(text) ? text : null;
}

function operationEvidence(operation, value) {
  return {
    operation,
    endpoint: value.endpoint,
    pageCount: value.pageCount,
    totalCount: value.totalCount,
    providerResultCode: "0",
    schemaStatus: "EXPECTED",
    rawResponseSha256: value.rawResponseSha256,
  };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function decodedServiceKey(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalize(value) { return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]+/gu, ""); }
function normalizeTrainNumber(value) { const digits = String(value ?? "").replace(/\D+/g, "").replace(/^0+/, ""); if (digits === "") throw new Error("invalid train number"); return digits; }
function normalizeStationName(value) { return String(value ?? "").replace(/\([^)]*\)/g, "").replace(/[^\p{L}\p{N}]+/gu, "").toLocaleLowerCase("ko-KR"); }
function requiredString(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`); return value; }
function safeToken(value) { const text = String(value ?? "UNKNOWN"); return /^[A-Za-z0-9._/+:-]{1,64}$/.test(text) ? text : "UNKNOWN"; }
function safeLabel(value) { const text = String(value ?? "UNKNOWN"); return /^[\p{L}\p{N} ._()+/-]{1,64}$/u.test(text) ? text : "UNKNOWN"; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function naturalCompare(left, right) { return String(left).localeCompare(String(right), "ko", { numeric: true }); }
function parseArgs(argv) { const result = {}; for (let i = 0; i < argv.length; i += 2) result[argv[i]?.replace(/^--/, "")] = argv[i + 1]; return result; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = requiredString(args.output, "--output");
  if (!path.isAbsolute(output)) throw new Error("--output must be absolute");
  const trainNumberEvidence = JSON.parse(await readFile(requiredString(args["train-number-evidence"], "--train-number-evidence"), "utf8"));
  const artifact = await collectKorailItxCheongchunTimetable({
    serviceKey: process.env.DATA_GO_KR_SERVICE_KEY,
    runDate: args.date,
    kricServiceDayCode: args["kric-day-cd"],
    packPath: args["canonical-pack"],
    trainNumberEvidence,
  });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `sanitized Korail ITX-청춘 evidence ready: status=${artifact.materialization.status},` +
    ` trains=${artifact.trainCount}, sequences=${artifact.stationSequenceRowCount}, stops=${artifact.stopTimeCount}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Korail ITX-청춘 collector failed");
    process.exitCode = 1;
  });
}
