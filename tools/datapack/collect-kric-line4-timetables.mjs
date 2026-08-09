#!/usr/bin/env node
// KRIC 4호선 시각표 수집+재구성 러너 (③b→③c 연결).
// 로스터(subwayRouteInfo 캡처) → 계획(plan-kric-line4-collection) → KRIC 라이브 호출 →
// normalizer(#1803) → 재구성 코어(#1797) → transitTrips/transitStopTimes 산출물.
//
// 실행: KRIC_SERVICE_KEY=... node collect-kric-line4-timetables.mjs \
//         --roster tools/datapack/sources/kric-line4-route-roster-20260706.json \
//         --line-id seoul-4 --service-pattern-evidence <evidence.json> \
//         --output <out.json> [--day-cds 8,7,9] [--no-express]
//
// serviceKey는 URL 로그·산출물에 남기지 않는다(#1397 공통 규칙).
import { isMainModule } from "../lib/is-main-module.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { buildKricLine4CollectionPlan } from "./plan-kric-line4-collection.mjs";
import { normalizeKricSubwayTimetable } from "./normalize-kric-timetable.mjs";
import { reconstructTransitTrips } from "./reconstruct-transit-trips.mjs";
import { cleanupPackDir, openPack } from "../route-map/pack-io.mjs";

const SERVICE_ID_BY_DAY_CD = { "8": "weekday-kric", "7": "saturday-kric", "9": "holiday-kric" };

export function buildCollectionContext(roster, lineId, fixture = null, servicePatternByExptCd) {
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
    servicePatternByExptCd: requireServicePatternMapping(servicePatternByExptCd),
  };
}

export function buildCollectionContextFromPack(roster, lineId, packPath, servicePatternByExptCd) {
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
    }] }, servicePatternByExptCd);
  } finally {
    opened.db.close();
    cleanupPackDir(opened.dir);
  }
}

export function filterRowsByTrainNumbers(rows, trainNumbers) {
  if (!Array.isArray(trainNumbers) || trainNumbers.length === 0) {
    throw new Error("train number filter must be a non-empty array");
  }
  const allowed = new Set(trainNumbers.map(normalizeTrainNumber));
  const filtered = rows.filter((row) => allowed.has(normalizeTrainNumber(row.trnNo)));
  if (filtered.some(({ servicePattern }) => servicePattern !== "LOCAL" && servicePattern !== "EXPRESS")) {
    throw new Error("filtered rows must have servicePattern LOCAL or EXPRESS");
  }
  return filtered;
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

export function buildServicePatternObservation(request, rawResponse, rows) {
  if (request?.operation !== "subwayTimetableExp") {
    throw new Error("service-pattern probe requires subwayTimetableExp");
  }
  const params = request.params ?? {};
  for (const field of ["railOprIsttCd", "dayCd", "lnCd", "stinCd"]) {
    if (typeof params[field] !== "string" || params[field].length === 0) {
      throw new Error(`service-pattern probe request.${field} is required`);
    }
  }
  const expectedRequestKey = [
    request.operation,
    params.railOprIsttCd,
    params.stinCd,
    params.dayCd,
  ].join("|");
  if (request.requestKey !== expectedRequestKey) {
    throw new Error("service-pattern probe requestKey does not match request params");
  }
  if (typeof rawResponse !== "string" || rawResponse.length === 0) {
    throw new Error("service-pattern probe raw response is required");
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("service-pattern probe response rows must be non-empty");
  }

  const counts = new Map();
  for (const row of rows) {
    if (!Object.hasOwn(row ?? {}, "exptCd")) {
      throw new Error("service-pattern probe response row exptCd is required");
    }
    if (row.exptCd !== null && typeof row.exptCd !== "string") {
      throw new Error("service-pattern probe response row exptCd must be a string or null");
    }
    const key = JSON.stringify(row.exptCd);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const observedExptCd = [...counts]
    .map(([key, count]) => ({ value: JSON.parse(key), count }))
    .sort((left, right) => {
      if (left.value === null) return right.value === null ? 0 : -1;
      if (right.value === null) return 1;
      return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
    });

  return {
    schemaVersion: 1,
    artifactKind: "kric-subway-timetable-service-pattern-observation",
    sourceId: "kric-subway-timetable",
    operation: request.operation,
    request: {
      requestKey: request.requestKey,
      railOprIsttCd: params.railOprIsttCd,
      dayCd: params.dayCd,
      lnCd: params.lnCd,
      stinCd: params.stinCd,
    },
    response: {
      rawSha256: createHash("sha256").update(rawResponse).digest("hex"),
      rowCount: rows.length,
      observedExptCd,
    },
  };
}

export function selectServicePatternProbeRequest(plan, requestKey) {
  const matches = (plan?.requests ?? []).filter((request) => request.requestKey === requestKey);
  if (matches.length !== 1) {
    throw new Error("service-pattern probe request key must match exactly one tracked request");
  }
  return matches[0];
}

export function buildTimetableNoDataObservation(request, rawResponse, payload) {
  if (request?.operation !== "subwayTimetableExp" || request?.params?.dayCd !== "7") {
    throw new Error("timetable no-data probe requires subwayTimetableExp dayCd=7");
  }
  const params = request.params;
  const expectedRequestKey = [
    request.operation,
    params.railOprIsttCd,
    params.stinCd,
    params.dayCd,
  ].join("|");
  if (request.requestKey !== expectedRequestKey) {
    throw new Error("timetable no-data probe requestKey does not match request params");
  }
  if (typeof rawResponse !== "string" || rawResponse.length === 0) {
    throw new Error("timetable no-data probe raw response is required");
  }
  const resultCode = payload?.header?.resultCode;
  const resultMsg = payload?.header?.resultMsg;
  if (resultCode !== "03" || typeof resultMsg !== "string" || resultMsg.trim() === "") {
    throw new Error("timetable no-data probe requires provider resultCode 03 and message");
  }
  const body = payload?.body;
  if (body != null && (!Array.isArray(body) || body.length !== 0)) {
    throw new Error("timetable no-data probe body must be empty");
  }
  return {
    schemaVersion: 1,
    artifactKind: "kric-subway-timetable-no-data-observation",
    sourceId: "kric-subway-timetable",
    operation: request.operation,
    request: {
      requestKey: request.requestKey,
      railOprIsttCd: params.railOprIsttCd,
      dayCd: params.dayCd,
      lnCd: params.lnCd,
      stinCd: params.stinCd,
    },
    response: {
      rawSha256: createHash("sha256").update(rawResponse).digest("hex"),
      resultCode,
      resultMsg,
      bodyRowCount: Array.isArray(body) ? body.length : 0,
    },
  };
}

export function validateServicePatternEvidence(evidence) {
  const expectedTopKeys = [
    "artifactKind",
    "mapping",
    "officialDocumentationUrl",
    "operation",
    "probe",
    "providerResultCode",
    "schemaVersion",
    "sourceId",
    "sourceIssue",
  ];
  if (!hasExactKeys(evidence, expectedTopKeys)
    || evidence.schemaVersion !== 1
    || evidence.artifactKind !== "kric-subway-timetable-service-pattern-evidence"
    || evidence.sourceIssue !== 28
    || evidence.sourceId !== "kric-subway-timetable"
    || evidence.officialDocumentationUrl !== "https://data.kric.go.kr/rips/M_01_02/detail.do?id=434&service=trainUseInfo&operation=subwayTimetableExp"
    || evidence.operation !== "subwayTimetableExp"
    || evidence.providerResultCode !== "00") {
    throw new Error("service-pattern evidence identity is invalid");
  }

  const probe = evidence.probe;
  if (!hasExactKeys(probe, ["observedExptCd", "rawSha256", "requestKey", "rowCount"])
    || probe.requestKey !== "subwayTimetableExp|S1|433|8"
    || probe.rawSha256 !== "7a930f324ceb68dfc99f8543da5b442489355b743987235c031aafdedbd202fc"
    || probe.rowCount !== 473
    || JSON.stringify(probe.observedExptCd) !== JSON.stringify([
      { value: null, count: 466 },
      { value: "1", count: 7 },
    ])) {
    throw new Error("service-pattern evidence probe identity is invalid");
  }

  if (JSON.stringify(evidence.mapping) !== JSON.stringify([
    { exptCd: null, servicePattern: "LOCAL" },
    { exptCd: "1", servicePattern: "EXPRESS" },
  ])) {
    throw new Error("service-pattern evidence closed mapping is invalid");
  }
  return new Map(evidence.mapping.map(({ exptCd, servicePattern }) => [exptCd, servicePattern]));
}

export function validateTimetableNoDataEvidence(evidence) {
  if (!hasExactKeys(evidence, [
    "artifactKind",
    "classification",
    "officialDocumentationUrl",
    "operation",
    "probe",
    "schemaVersion",
    "sourceId",
    "sourceIssue",
  ])
    || evidence.schemaVersion !== 1
    || evidence.artifactKind !== "kric-subway-timetable-no-data-evidence"
    || evidence.sourceIssue !== 28
    || evidence.sourceId !== "kric-subway-timetable"
    || evidence.officialDocumentationUrl !== "https://data.kric.go.kr/rips/M_01_02/detail.do?id=434&service=trainUseInfo&operation=subwayTimetableExp"
    || evidence.operation !== "subwayTimetableExp"
    || JSON.stringify(evidence.probe) !== JSON.stringify({
      requestKey: "subwayTimetableExp|S1|433|7",
      rawSha256: "826aedce696396835866fce27ff5f4770ef2a24e9aab1247556a7952972cde14",
      resultCode: "03",
      resultMsg: "데이터가 없습니다.",
      bodyRowCount: 0,
    })
    || JSON.stringify(evidence.classification) !== JSON.stringify({
      state: "EXPECTED_NO_DATA_SATURDAY",
      expectedDayCd: "7",
      expectedRequestCount: 51,
      calendarServiceId: "holiday-kric",
      productionCoverageClaim: false,
    })) {
    throw new Error("timetable no-data evidence identity is invalid");
  }
  return evidence;
}

export function classifyKricTimetablePayload(payload, request, noDataEvidence) {
  const code = payload?.header?.resultCode;
  if (code === "00") {
    if (!Array.isArray(payload.body) || payload.body.length === 0) {
      throw new Error("KRIC timetable success body must be a non-empty array");
    }
    return { classification: "ROWS", rows: payload.body };
  }
  if (code === "03"
    && request?.params?.dayCd === noDataEvidence?.classification?.expectedDayCd
    && payload?.header?.resultMsg === noDataEvidence?.probe?.resultMsg
    && (payload.body == null || (Array.isArray(payload.body) && payload.body.length === 0))) {
    return { classification: noDataEvidence.classification.state, rows: [] };
  }
  const safeCode = /^[A-Za-z0-9._-]{1,32}$/.test(String(code ?? "")) ? code : "UNKNOWN";
  throw new Error(`KRIC timetable provider resultCode ${safeCode}`);
}

export function assertCompleteSaturdayNoData(plan, perRequest, noDataEvidence) {
  const expected = (plan?.requests ?? [])
    .filter((request) => request?.params?.dayCd === noDataEvidence?.classification?.expectedDayCd)
    .map(({ requestKey }) => requestKey);
  const observed = (perRequest ?? [])
    .filter(({ classification }) => classification === noDataEvidence?.classification?.state)
    .map(({ requestKey, resultCode, rows, normalized }) => ({ requestKey, resultCode, rows, normalized }));
  if (expected.length !== noDataEvidence?.classification?.expectedRequestCount
    || observed.length !== expected.length
    || observed.some((entry, index) => entry.requestKey !== expected[index]
      || entry.resultCode !== "03" || entry.rows !== 0 || entry.normalized !== 0)) {
    throw new Error("KRIC timetable Saturday no-data complete-set is invalid");
  }
}

export function buildRawResponseRecord(request, rawResponse) {
  if (typeof request?.requestKey !== "string" || request.requestKey.length === 0) {
    throw new Error("raw response requestKey is required");
  }
  if (typeof rawResponse !== "string" || rawResponse.length === 0) {
    throw new Error("raw provider response bytes are required");
  }
  const bytes = Buffer.from(rawResponse, "utf8");
  return {
    requestKey: request.requestKey,
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    bodyBase64: bytes.toString("base64"),
  };
}

export function buildRawCollectionInventory(plan, responses) {
  const requests = plan?.requests;
  if (!Array.isArray(requests) || requests.length === 0
    || !Array.isArray(responses) || responses.length !== requests.length) {
    throw new Error("raw response inventory must cover every tracked request");
  }
  const seen = new Set();
  responses.forEach((response, index) => {
    if (!hasExactKeys(response, ["bodyBase64", "byteSize", "rawSha256", "requestKey"])
      || response.requestKey !== requests[index]?.requestKey) {
      throw new Error("raw response inventory request order is invalid");
    }
    if (seen.has(response.requestKey)) {
      throw new Error("raw response inventory request keys must be unique");
    }
    seen.add(response.requestKey);
    if (typeof response.bodyBase64 !== "string" || response.bodyBase64.length === 0
      || !Number.isInteger(response.byteSize) || response.byteSize < 1
      || !/^[a-f0-9]{64}$/.test(response.rawSha256)) {
      throw new Error("raw response identity is invalid");
    }
    const bytes = Buffer.from(response.bodyBase64, "base64");
    if (bytes.toString("base64") !== response.bodyBase64
      || bytes.length !== response.byteSize
      || createHash("sha256").update(bytes).digest("hex") !== response.rawSha256) {
      throw new Error("raw response identity is invalid");
    }
  });
  return {
    responseCount: responses.length,
    inventorySha256: createHash("sha256").update(JSON.stringify(responses)).digest("hex"),
    responses,
  };
}

export function buildCollectionTimestamps(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("collection clock must be a valid Date");
  }
  const collectedAt = now.toISOString();
  return { collectedAt, capturedAt: collectedAt.slice(0, 10) };
}

export function buildTrainDiagnosticArtifact({ lineId, trainNumber, plan, rawResponses, rows, timestamps }) {
  const normalizedTrainNumber = normalizeTrainNumber(trainNumber);
  const matchingRows = (rows ?? []).filter(
    (row) => normalizeTrainNumber(row.trnNo) === normalizedTrainNumber,
  );
  if (matchingRows.length === 0) {
    throw new Error(`KRIC timetable train diagnostic has no rows: ${normalizedTrainNumber}`);
  }
  return {
    schemaVersion: 1,
    artifactKind: "kric-line4-timetable-train-diagnostic",
    sourceId: "kric-subway-timetable",
    lineId,
    trainNumber: normalizedTrainNumber,
    ...timestamps,
    requestCount: plan.requests.length,
    rowCount: matchingRows.length,
    rawResponseInventory: buildRawCollectionInventory(plan, rawResponses),
    rows: matchingRows,
  };
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

function requireServicePatternMapping(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("servicePatternByExptCd is required");
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  for (const [code, servicePattern] of entries) {
    if ((code !== null && (typeof code !== "string" || code.trim() === ""))
      || (servicePattern !== "LOCAL" && servicePattern !== "EXPRESS")) {
      throw new Error("servicePatternByExptCd values must be LOCAL or EXPRESS");
    }
  }
  if (entries.length === 0) throw new Error("servicePatternByExptCd is required");
  return value;
}

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
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
  if (args["service-pattern-probe-request-key"] && args["no-data-probe-request-key"]) {
    throw new Error("use only one evidence probe request key");
  }
  if (args["no-data-probe-request-key"]) {
    if (!args.output) {
      throw new Error("no-data probe --output is required");
    }
    const request = selectServicePatternProbeRequest(plan, args["no-data-probe-request-key"]);
    const rawResponse = await fetchWithRetry(kricRequestUrl(request, key));
    const observation = buildTimetableNoDataObservation(
      request,
      rawResponse,
      JSON.parse(rawResponse),
    );
    await writeFile(args.output, `${JSON.stringify(observation, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
    return;
  }
  if (args["service-pattern-probe-request-key"]) {
    if (!args.output) {
      throw new Error("service-pattern probe --output is required");
    }
    const request = selectServicePatternProbeRequest(
      plan,
      args["service-pattern-probe-request-key"],
    );
    const rawResponse = await fetchWithRetry(kricRequestUrl(request, key));
    const rows = validateKricTimetablePayload(JSON.parse(rawResponse));
    const observation = buildServicePatternObservation(request, rawResponse, rows);
    await writeFile(args.output, `${JSON.stringify(observation, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
    return;
  }
  if (fixture && args["canonical-pack"]) {
    throw new Error("use only one of --canonical-fixture or --canonical-pack");
  }
  if (!args["service-pattern-evidence"]) {
    throw new Error("--service-pattern-evidence is required");
  }
  if (!args["no-data-evidence"]) {
    throw new Error("--no-data-evidence is required");
  }
  if (args["train-diagnostic-number"] && !args.output) {
    throw new Error("train diagnostic --output is required");
  }
  const servicePatternByExptCd = validateServicePatternEvidence(
    JSON.parse(await readFile(args["service-pattern-evidence"], "utf8")),
  );
  const noDataEvidence = validateTimetableNoDataEvidence(
    JSON.parse(await readFile(args["no-data-evidence"], "utf8")),
  );
  const context = args["canonical-pack"]
    ? buildCollectionContextFromPack(roster, lineId, args["canonical-pack"], servicePatternByExptCd)
    : buildCollectionContext(roster, lineId, fixture, servicePatternByExptCd);

  const intermediate = [];
  const perRequest = [];
  const rawResponses = [];
  let failed = 0;
  for (const request of plan.requests) {
    const url = kricRequestUrl(request, key);
    try {
      const rawResponse = await fetchWithRetry(url);
      const payload = JSON.parse(rawResponse);
      const { classification, rows } = classifyKricTimetablePayload(payload, request, noDataEvidence);
      if (classification === noDataEvidence.classification.state) {
        rawResponses.push(buildRawResponseRecord(request, rawResponse));
        perRequest.push({ requestKey: request.requestKey, classification, resultCode: "03", rows: 0, normalized: 0 });
        continue;
      }
      // servicePattern은 evidence-backed closed exptCd mapping이 있어야만 normalizer가 해석한다.
      const normalized = normalizeKricSubwayTimetable(rows, context);
      intermediate.push(...normalized);
      rawResponses.push(buildRawResponseRecord(request, rawResponse));
      perRequest.push({ requestKey: request.requestKey, classification, resultCode: "00", rows: rows.length, normalized: normalized.length });
    } catch (error) {
      failed += 1;
      perRequest.push({ requestKey: request.requestKey, error: redactKricCredential(String(error.message), key) });
    }
  }

  assertCompleteKricCollection(failed, plan.requestCount, perRequest);
  if (args["train-diagnostic-number"]) {
    const diagnostic = buildTrainDiagnosticArtifact({
      lineId,
      trainNumber: args["train-diagnostic-number"],
      plan,
      rawResponses,
      rows: intermediate,
      timestamps: buildCollectionTimestamps(),
    });
    await writeFile(args.output, `${JSON.stringify(diagnostic, null, 2)}\n`);
    const { rawResponseInventory: _raw, rows: _rows, ...summary } = diagnostic;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  assertCompleteSaturdayNoData(plan, perRequest, noDataEvidence);
  const evidenceDayCds = trainNumberEvidence ? evidenceServiceDayCds(trainNumberEvidence) : null;
  if (trainNumberEvidence && trainNumberEvidence.serviceId !== "ITX_CHEONGCHUN") {
    throw new Error("ITX OD evidence serviceId is invalid");
  }
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
  const rawResponseInventory = buildRawCollectionInventory(plan, rawResponses);
  const timestamps = buildCollectionTimestamps();
  const artifact = {
    artifactKind: "kric-line4-timetable-collection",
    sourceId: "kric-subway-route-info",
    lineId,
    operation: plan.operation,
    ...timestamps,
    requestCount: plan.requestCount,
    failedRequestCount: failed,
    expectedNoDataRequestCount: perRequest.filter(({ classification }) => classification === noDataEvidence.classification.state).length,
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
    rawResponseInventory,
    perRequest,
    transitTrips,
    transitStopTimes,
  };
  if (args.output) {
    await writeFile(args.output, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  const { transitTrips: _t, transitStopTimes: _s, perRequest: _p, rawResponseInventory: _r, ...summary } = artifact;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function kricRequestUrl(request, key) {
  return `${request.endpoint}?serviceKey=${encodeURIComponent(key)}&format=json&railOprIsttCd=${request.params.railOprIsttCd}&dayCd=${request.params.dayCd}&lnCd=${request.params.lnCd}&stinCd=${request.params.stinCd}`;
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
