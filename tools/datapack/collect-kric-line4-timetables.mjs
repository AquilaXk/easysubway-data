#!/usr/bin/env node
// KRIC 4호선 시각표 수집+재구성 러너 (③b→③c 연결).
// 로스터(subwayRouteInfo 캡처) → 계획(plan-kric-line4-collection) → KRIC 라이브 호출 →
// normalizer(#1803) → 재구성 코어(#1797) → transitTrips/transitStopTimes 산출물.
//
// 실행: KRIC_SERVICE_KEY=... node collect-kric-line4-timetables.mjs \
//         --roster tools/datapack/sources/kric-line4-route-roster-20260706.json \
//         --line-id seoul-4 --output <out.json> [--day-cds 8,7,9] [--no-express]
//
// serviceKey는 URL 로그·산출물에 남기지 않는다(#1397 공통 규칙).
import { isMainModule } from "../lib/is-main-module.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { buildKricLine4CollectionPlan } from "./plan-kric-line4-collection.mjs";
import { normalizeKricSubwayTimetable } from "./normalize-kric-timetable.mjs";
import { reconstructTransitTrips } from "./reconstruct-transit-trips.mjs";
import { cleanupPackDir, openPack } from "../route-map/pack-io.mjs";

const SERVICE_ID_BY_DAY_CD = { "8": "weekday-kric", "7": "saturday-kric", "9": "holiday-kric" };

export function buildCollectionContext(roster, lineId, fixture = null) {
  const stationIdByProviderStation = {};
  const lineIdByProviderLine = {};
  const lineSequenceByStationLine = {};
  const canonical = fixture ? canonicalStationIndex(fixture, lineId) : null;
  for (const station of roster.stations) {
    const canonicalStation = canonical?.get(normalizeStationName(station.stinNm));
    if (canonical && !canonicalStation) {
      throw new Error(`KRIC roster station has no canonical mapping: ${station.stinCd}/${station.stinNm}`);
    }
    const stationId = canonicalStation?.stationId ?? `station-${lineId}-${station.stinCd}`;
    stationIdByProviderStation[`${station.railOprIsttCd}|${roster.lnCd}|${station.stinCd}`] = stationId;
    lineIdByProviderLine[`${station.railOprIsttCd}|${roster.lnCd}`] = lineId;
    lineSequenceByStationLine[`${stationId}|${lineId}`] = canonicalStation?.lineSequence ?? station.stinConsOrdr;
  }
  return {
    stationIdByProviderStation,
    lineIdByProviderLine,
    lineSequenceByStationLine,
    routeIdByLineDirection: { [`${lineId}|up`]: `route-${lineId}-up`, [`${lineId}|down`]: `route-${lineId}-down` },
    serviceIdByDayCd: SERVICE_ID_BY_DAY_CD,
  };
}

export function buildCollectionContextFromPack(roster, lineId, packPath) {
  const opened = openPack(packPath, "kric-canonical-");
  try {
    const rows = opened.db.prepare(`
      SELECT stations.id, stations.name_ko, station_lines.line_sequence
      FROM station_lines
      JOIN stations ON stations.id = station_lines.station_id
      WHERE station_lines.line_id = ?
      ORDER BY station_lines.line_sequence, stations.id
    `).all(lineId);
    return buildCollectionContext(roster, lineId, { packs: [{
      stations: rows.map(({ id, name_ko }) => ({ id, nameKo: name_ko })),
      stationLines: rows.map(({ id, line_sequence }) => ({ stationId: id, lineId, lineSequence: line_sequence })),
    }] });
  } finally {
    opened.db.close();
    cleanupPackDir(opened.dir);
  }
}

export function filterRowsByTrainNumbers(rows, trainNumbers, servicePattern = "EXPRESS") {
  const allowed = new Set((trainNumbers ?? []).map(normalizeTrainNumber));
  if (allowed.size === 0) throw new Error("train number filter must be non-empty");
  return rows
    .filter((row) => allowed.has(normalizeTrainNumber(row.trnNo)))
    .map((row) => ({ ...row, servicePattern }));
}

export function validateItxOdJoin(rows, evidence) {
  if (evidence?.serviceId !== "ITX_CHEONGCHUN") throw new Error("ITX OD evidence serviceId is invalid");
  const dayCd = evidence?.kricServiceDayCode;
  if (!["7", "8", "9"].includes(dayCd)) throw new Error("kricServiceDayCode must be 7, 8, or 9");
  const departureStationId = evidence?.departureStation?.canonicalStationId;
  const arrivalStationId = evidence?.arrivalStation?.canonicalStationId;
  if (typeof departureStationId !== "string" || typeof arrivalStationId !== "string") {
    throw new Error("ITX OD evidence canonical endpoint mappings are required");
  }
  if (!Array.isArray(evidence.trainNumbers) || !Array.isArray(evidence.itineraries)
    || evidence.trainNumbers.length === 0 || evidence.trainNumbers.length !== evidence.itineraries.length) {
    throw new Error("ITX OD evidence trainNumbers and itineraries must be complete and unique");
  }
  const rowsByTrain = new Map();
  for (const row of rows) {
    const trainNumber = normalizeTrainNumber(row.trnNo);
    const key = `${trainNumber}|${row.dayCd}`;
    const grouped = rowsByTrain.get(key) ?? [];
    grouped.push(row);
    rowsByTrain.set(key, grouped);
  }
  const itineraryNumbers = new Set();
  for (const [index, itinerary] of evidence.itineraries.entries()) {
    const trainNumber = normalizeTrainNumber(itinerary?.trainNumber);
    if (itineraryNumbers.has(trainNumber)) throw new Error(`ITX OD evidence duplicate train number: ${trainNumber}`);
    itineraryNumbers.add(trainNumber);
    const trainRows = rowsByTrain.get(`${trainNumber}|${dayCd}`) ?? [];
    const departures = trainRows.filter(({ stationId }) => stationId === departureStationId);
    const arrivals = trainRows.filter(({ stationId }) => stationId === arrivalStationId);
    if (departures.length === 0 || arrivals.length === 0) {
      throw new Error(`ITX timetable missing OD endpoint row: ${trainNumber}`);
    }
    if (departures.length !== 1 || arrivals.length !== 1) {
      throw new Error(`ITX timetable duplicate OD endpoint row: ${trainNumber}`);
    }
    const expectedDeparture = isoServiceSeconds(itinerary.departureAt, `itineraries[${index}].departureAt`);
    const expectedArrival = isoServiceSeconds(itinerary.arrivalAt, `itineraries[${index}].arrivalAt`);
    if (departures[0].departureSeconds !== expectedDeparture || arrivals[0].arrivalSeconds !== expectedArrival) {
      throw new Error(`ITX timetable OD time mismatch: ${trainNumber}`);
    }
  }
  const declared = new Set(evidence.trainNumbers.map(normalizeTrainNumber));
  if (declared.size !== evidence.trainNumbers.length || declared.size !== itineraryNumbers.size
    || [...declared].some((trainNumber) => !itineraryNumbers.has(trainNumber))) {
    throw new Error("ITX OD evidence trainNumbers and itineraries do not match");
  }
}

function isoServiceSeconds(value, label) {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})\+09:00$/.exec(String(value ?? ""));
  if (!match) throw new Error(`${label} must use Asia/Seoul ISO timestamp`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error(`${label} is invalid`);
  return (hours < 3 ? hours + 24 : hours) * 3600 + minutes * 60 + seconds;
}

function evidenceServiceDayCds(evidence) {
  if (!["7", "8", "9"].includes(evidence?.kricServiceDayCode)) {
    throw new Error("kricServiceDayCode must be 7, 8, or 9");
  }
  return new Set([evidence.kricServiceDayCode]);
}

export function validateKricTimetablePayload(payload) {
  const code = payload?.header?.resultCode;
  if (code !== "00") {
    const safeCode = /^[A-Za-z0-9._-]{1,32}$/.test(String(code ?? "")) ? code : "UNKNOWN";
    throw new Error(`KRIC timetable provider resultCode ${safeCode}`);
  }
  if (!Array.isArray(payload.body)) throw new Error("KRIC timetable body must be an array");
  return payload.body;
}

export function assertCompleteKricCollection(failedRequestCount, requestCount, perRequest = []) {
  if (failedRequestCount !== 0) {
    const diagnostics = [...new Set(perRequest.flatMap(({ error }) => error ? [error] : []))].slice(0, 10);
    const suffix = diagnostics.length === 0 ? "" : `; diagnostics=${diagnostics.join(",")}`;
    throw new Error(`KRIC timetable collection failed requests: ${failedRequestCount}/${requestCount}${suffix}`);
  }
}

export function redactKricCredential(text, key) {
  let redacted = String(text);
  for (const value of [key, key ? encodeURIComponent(key) : ""]) {
    if (value) redacted = redacted.split(value).join("[KEY]");
  }
  return redacted;
}

function normalizeTrainNumber(value) {
  const digits = String(value ?? "").replace(/\D+/g, "").replace(/^0+/, "");
  if (digits === "") throw new Error(`invalid train number: ${value ?? "missing"}`);
  return digits;
}

function canonicalStationIndex(fixture, lineId) {
  const pack = fixture?.packs?.[0];
  if (!pack || !Array.isArray(pack.stations) || !Array.isArray(pack.stationLines)) {
    throw new Error("canonical fixture stations and stationLines are required");
  }
  const stationById = new Map(pack.stations.map((station) => [station.id, station]));
  const index = new Map();
  for (const stationLine of pack.stationLines.filter((entry) => entry.lineId === lineId)) {
    const station = stationById.get(stationLine.stationId);
    if (!station || !Number.isInteger(stationLine.lineSequence)) {
      throw new Error(`canonical fixture line mapping is invalid: ${stationLine.stationId}`);
    }
    const name = normalizeStationName(station.nameKo);
    if (index.has(name)) throw new Error(`duplicate canonical station name on line: ${name}`);
    index.set(name, { stationId: station.id, lineSequence: stationLine.lineSequence });
  }
  if (index.size === 0) throw new Error(`canonical fixture has no stations for line: ${lineId}`);
  return index;
}

function normalizeStationName(value) {
  return String(value ?? "").replace(/\([^)]*\)/g, "").replace(/[^\p{L}\p{N}]+/gu, "").toLocaleLowerCase("ko-KR");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roster = JSON.parse(await readFile(args.roster, "utf8"));
  const lineId = args["line-id"] ?? "seoul-4";
  const fixture = args["canonical-fixture"]
    ? JSON.parse(await readFile(args["canonical-fixture"], "utf8"))
    : null;
  const trainNumberEvidence = args["train-number-evidence"]
    ? JSON.parse(await readFile(args["train-number-evidence"], "utf8"))
    : null;
  const key = process.env.KRIC_SERVICE_KEY;
  if (!key) {
    throw new Error("KRIC_SERVICE_KEY env is required");
  }
  const plan = buildKricLine4CollectionPlan(roster, {
    dayCds: args["day-cds"] ? args["day-cds"].split(",") : undefined,
    includeExpress: args.express !== "false",
    operation: args.operation,
  });
  if (fixture && args["canonical-pack"]) {
    throw new Error("use only one of --canonical-fixture or --canonical-pack");
  }
  const context = args["canonical-pack"]
    ? buildCollectionContextFromPack(roster, lineId, args["canonical-pack"])
    : buildCollectionContext(roster, lineId, fixture);

  const intermediate = [];
  const perRequest = [];
  let failed = 0;
  for (const request of plan.requests) {
    const url = `${request.endpoint}?serviceKey=${encodeURIComponent(key)}&format=json&railOprIsttCd=${request.params.railOprIsttCd}&dayCd=${request.params.dayCd}&lnCd=${request.params.lnCd}&stinCd=${request.params.stinCd}`;
    try {
      const payload = JSON.parse(await fetchWithRetry(url));
      const rows = validateKricTimetablePayload(payload);
      // servicePattern은 normalizer가 row별 exptCd로 도출한다(급행 표시 시각표).
      const normalized = normalizeKricSubwayTimetable(rows, context);
      intermediate.push(...normalized);
      perRequest.push({ requestKey: request.requestKey, resultCode: "00", rows: rows.length, normalized: normalized.length });
    } catch (error) {
      failed += 1;
      perRequest.push({ requestKey: request.requestKey, error: redactKricCredential(String(error.message), key) });
    }
  }

  assertCompleteKricCollection(failed, plan.requestCount, perRequest);
  const evidenceDayCds = trainNumberEvidence ? evidenceServiceDayCds(trainNumberEvidence) : null;
  const reconstructionRows = trainNumberEvidence
    ? filterRowsByTrainNumbers(intermediate, trainNumberEvidence.trainNumbers)
      .filter(({ dayCd }) => evidenceDayCds.has(dayCd))
    : intermediate;
  if (trainNumberEvidence && reconstructionRows.length === 0) {
    const available = [...new Set(intermediate.map(({ trnNo }) => trnNo))]
      .sort((left, right) => left.localeCompare(right, "ko", { numeric: true }))
      .slice(-50);
    const express = [...new Set(intermediate.filter(({ servicePattern }) => servicePattern === "EXPRESS").map(({ trnNo }) => trnNo))]
      .sort((left, right) => left.localeCompare(right, "ko", { numeric: true }));
    const diagnostics = [...new Set(perRequest.map(({ resultCode, error }) => resultCode ?? error ?? "UNKNOWN"))].slice(0, 10);
    throw new Error(
      `KRIC timetable contains no rows matching TAGO train numbers; diagnostics=${diagnostics.join(",")}; ` +
      `availableTail=${available.join(",")}; express=${express.join(",")}`,
    );
  }
  if (trainNumberEvidence) validateItxOdJoin(reconstructionRows, trainNumberEvidence);
  const { transitTrips, transitStopTimes } = reconstructTransitTrips(reconstructionRows, context);
  const artifact = {
    artifactKind: "kric-line4-timetable-collection",
    sourceId: "kric-subway-route-info",
    lineId,
    operation: plan.operation,
    capturedAt: new Date().toISOString().slice(0, 10),
    requestCount: plan.requestCount,
    failedRequestCount: failed,
    intermediateRowCount: intermediate.length,
    reconstructionRowCount: reconstructionRows.length,
    ...(trainNumberEvidence ? {
      trainNumberFilter: {
        sourceArtifactKind: trainNumberEvidence.artifactKind,
        serviceId: trainNumberEvidence.serviceId,
        trainNumberCount: trainNumberEvidence.trainNumbers.length,
        evidenceHash: trainNumberEvidence.evidenceHash,
      },
    } : {}),
    transitTripCount: transitTrips.length,
    transitStopTimeCount: transitStopTimes.length,
    perRequest,
    transitTrips,
    transitStopTimes,
  };
  if (args.output) {
    await writeFile(args.output, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  const { transitTrips: _t, transitStopTimes: _s, perRequest: _p, ...summary } = artifact;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    if (flag === "--no-express") {
      args.express = "false";
      continue;
    }
    args[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

// transient 네트워크 오류(DNS ENOTFOUND 등)에만 bounded retry를 적용한다.
async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const error = new Error(`KRIC timetable HTTP ${response.status}`);
        error.nonRetryable = true;
        throw error;
      }
      return await response.text();
    } catch (error) {
      if (error.nonRetryable === true) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
