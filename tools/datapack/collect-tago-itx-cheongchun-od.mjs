#!/usr/bin/env node
// 실행 시 --date YYYY-MM-DD, 검증된 KRIC 운행일 코드 --kric-day-cd 7|8|9,
// credential 비포함 absolute --output 경로를 함께 전달한다.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = "https://apis.data.go.kr/1613000/TrainInfo";
const DETAIL_URL = "https://www.data.go.kr/data/15098552/openapi.do";
const CANONICAL_STATIONS = Object.freeze({
  "청량리": "station-b819702fa7d9",
  "춘천": "station-dd14cfb89cbc",
});

export function validateItxServiceDates(serviceDates, { now = new Date(), replay = false } = {}) {
  const result = {};
  const today = calendarDate(kstDate(now));
  for (const dayCd of ["8", "7", "9"]) {
    const value = requiredString(serviceDates?.[dayCd], `dayCd ${dayCd} date`);
    const date = validateServiceDay(value, dayCd);
    const offset = Math.round((date - today) / 86_400_000);
    if (!replay && (offset < 0 || offset > 6)) throw new Error("ITX admission dates must be today through 6 days in Asia/Seoul");
    result[dayCd] = value;
  }
  return result;
}

export function buildItxOdMatrix(date, stations) {
  calendarDate(date);
  const ids = (stations ?? []).map(({ providerStationId }) => requiredString(providerStationId, "providerStationId")).sort();
  if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error("ITX roster stations must be unique and contain at least 2 stations");
  const rows = ids.flatMap((depStationId) => ids
    .filter((arrStationId) => arrStationId !== depStationId)
    .map((arrStationId) => ({ date, depStationId, arrStationId })));
  return {
    rows,
    expectedOdCount: ids.length * (ids.length - 1),
    stationSetHash: sha256(JSON.stringify(ids)),
    odMatrixHash: sha256(JSON.stringify(rows.map(({ date: serviceDate, depStationId, arrStationId }) => (
      [serviceDate, depStationId, arrStationId]
    )))),
  };
}

export async function collectTagoItxCheongchunRoster({
  serviceKey,
  serviceDate,
  kricServiceDayCode,
  canonicalStations,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const key = decodedServiceKey(requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  if (!["7", "8", "9"].includes(kricServiceDayCode)) throw new Error("kricServiceDayCode must be 7, 8, or 9");
  validateServiceDay(serviceDate, kricServiceDayCode);
  if (!Array.isArray(canonicalStations) || canonicalStations.length < 2) throw new Error("canonicalStations must contain at least 2 stations");

  const trainGrades = await fetchAll("GetVhcleKndList", {}, key, fetchImpl);
  const gradeRows = trainGrades.rows.filter((row) => normalize(row.vehiclekndnm) === "itx청춘");
  if (gradeRows.length !== 1) throw new Error("TAGO ITX-청춘 train grade is missing or ambiguous");
  const grade = gradeRows[0];
  const cities = await fetchAll("GetCtyCodeList", {}, key, fetchImpl);
  const stationOperations = [];
  const stationRows = [];
  for (const city of cities.rows) {
    const operation = await fetchAll("GetCtyAcctoTrainSttnList", {
      cityCode: requiredString(city.citycode, "citycode"),
    }, key, fetchImpl);
    stationOperations.push(operation);
    stationRows.push(...operation.rows);
  }
  const stations = [];
  const excludedCanonicalStations = [];
  for (const { canonicalStationId, nameKo } of canonicalStations) {
    const canonicalId = requiredString(canonicalStationId, "canonicalStations.canonicalStationId");
    const canonicalName = requiredString(nameKo, "canonicalStations.nameKo");
    const matches = stationRows.filter((row) => normalize(row.nodename) === normalize(canonicalName));
    if (matches.length === 0) {
      excludedCanonicalStations.push({
        canonicalStationId: canonicalId,
        nameKo: canonicalName,
        reasonCode: "NOT_IN_TAGO_TRAIN_STATION_CATALOG",
      });
      continue;
    }
    if (matches.length !== 1) throw new Error(`TAGO station mapping is missing or ambiguous: ${canonicalName}`);
    stations.push({
      providerStationId: requiredString(matches[0].nodeid, `${canonicalName}.nodeid`),
      providerStationName: matches[0].nodename,
      canonicalStationId: canonicalId,
    });
  }
  const matrix = buildItxOdMatrix(serviceDate, stations);
  const stationByProviderId = new Map(stations.map((station) => [station.providerStationId, station]));
  const odOperations = [];
  const itineraries = [];
  const failedOds = [];
  for (const { depStationId, arrStationId } of matrix.rows) {
    try {
      const operation = await fetchAll("GetStrtpntAlocFndTrainInfo", {
        depPlaceId: depStationId,
        arrPlaceId: arrStationId,
        depPlandTime: serviceDate,
        trainGradeCode: grade.vehiclekndid,
      }, key, fetchImpl);
      const departureStation = stationByProviderId.get(depStationId);
      const arrivalStation = stationByProviderId.get(arrStationId);
      const normalizedItineraries = operation.rows.map((row, index) => ({
        ...normalizeItinerary(row, index, {
          serviceDate,
          departureStationName: departureStation.providerStationName,
          arrivalStationName: arrivalStation.providerStationName,
        }),
        departureStationId: departureStation.canonicalStationId,
        arrivalStationId: arrivalStation.canonicalStationId,
      }));
      odOperations.push(operation);
      itineraries.push(...normalizedItineraries);
    } catch {
      failedOds.push({
        departureStationId: depStationId,
        arrivalStationId: arrStationId,
        reasonCode: "PROVIDER_OR_SCHEMA_FAILURE",
      });
    }
  }
  const trainNumbers = [...new Set(itineraries.map(({ trainNumber }) => trainNumber))].sort(naturalCompare);
  if (trainNumbers.length === 0 && failedOds.length === 0) throw new Error("TAGO ITX-청춘 roster returned zero rows");
  return {
    schemaVersion: 1,
    artifactKind: "tago-itx-cheongchun-roster-evidence",
    serviceId: "ITX_CHEONGCHUN",
    officialSourceUrl: DETAIL_URL,
    observedAt: now.toISOString(),
    serviceDate,
    kricServiceDayCode,
    trainGrade: { code: String(grade.vehiclekndid), name: grade.vehiclekndnm, serviceId: "ITX_CHEONGCHUN" },
    canonicalStationCount: canonicalStations.length,
    rosterStationCount: stations.length,
    excludedCanonicalStations: excludedCanonicalStations.sort((left, right) => naturalCompare(left.nameKo, right.nameKo)),
    stations: stations.sort((left, right) => left.providerStationId.localeCompare(right.providerStationId)),
    expectedOdCount: matrix.expectedOdCount,
    completedOdCount: odOperations.length,
    failedOdCount: failedOds.length,
    ...(failedOds.length > 0 ? { failedOds } : {}),
    stationSetHash: matrix.stationSetHash,
    odMatrixHash: matrix.odMatrixHash,
    operations: [trainGrades, cities, ...stationOperations, ...odOperations].map(operationEvidence),
    trainNumbers,
    itineraries,
    evidenceHash: sha256(JSON.stringify({
      serviceDate, kricServiceDayCode, stations, excludedCanonicalStations, matrix,
      ...(failedOds.length > 0 ? { failedOds } : {}), trainNumbers, itineraries,
    })),
    credentialRedacted: true,
  };
}

export async function collectTagoItxCheongchunOd({
  serviceKey,
  departureDate,
  kricServiceDayCode,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const key = decodedServiceKey(requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate ?? "")) throw new Error("departureDate must be YYYY-MM-DD");
  if (!["7", "8", "9"].includes(kricServiceDayCode)) {
    throw new Error("kricServiceDayCode must be 7, 8, or 9");
  }
  const trainGrades = await fetchAll("GetVhcleKndList", {}, key, fetchImpl);
  const gradeRows = trainGrades.rows.filter((row) => normalize(row.vehiclekndnm) === "itx청춘");
  if (gradeRows.length !== 1) throw new Error("TAGO ITX-청춘 train grade is missing or ambiguous");
  const grade = gradeRows[0];

  const cities = await fetchAll("GetCtyCodeList", {}, key, fetchImpl);
  const stationRows = [];
  for (const city of cities.rows) {
    const cityCode = requiredString(city.citycode, "citycode");
    const stations = await fetchAll("GetCtyAcctoTrainSttnList", { cityCode }, key, fetchImpl);
    stationRows.push(...stations.rows);
  }
  const departure = uniqueStation(stationRows, "청량리");
  const arrival = uniqueStation(stationRows, "춘천");
  const od = await fetchAll("GetStrtpntAlocFndTrainInfo", {
    depPlaceId: departure.nodeid,
    arrPlaceId: arrival.nodeid,
    depPlandTime: departureDate.replaceAll("-", ""),
    trainGradeCode: grade.vehiclekndid,
  }, key, fetchImpl);
  const itineraries = od.rows.map((row, index) => normalizeItinerary(row, index));
  const trainNumbers = [...new Set(itineraries.map(({ trainNumber }) => trainNumber))].sort(naturalCompare);
  if (itineraries.length === 0) throw new Error("TAGO ITX-청춘 OD returned zero rows");
  if (trainNumbers.length !== itineraries.length) throw new Error("TAGO ITX-청춘 OD duplicate train number");
  return {
    schemaVersion: 1,
    artifactKind: "tago-itx-cheongchun-od-evidence",
    serviceId: "ITX_CHEONGCHUN",
    officialSourceUrl: DETAIL_URL,
    license: "이용허락범위 제한 없음",
    developmentDailyQuota: 10_000,
    observedAt: now.toISOString(),
    departureDate,
    kricServiceDayCode,
    trainGrade: { code: String(grade.vehiclekndid), name: grade.vehiclekndnm, serviceId: "ITX_CHEONGCHUN" },
    departureStation: stationMapping(departure, "청량리"),
    arrivalStation: stationMapping(arrival, "춘천"),
    pickupDropoff: {
      status: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
      reasonCode: "OFFICIAL_OPERATION_FIELD_NOT_PROVIDED",
      operation: "GetStrtpntAlocFndTrainInfo",
      checkedAt: now.toISOString(),
    },
    fare: { status: "SUPPORTED", field: "adultcharge", unit: "KRW", passenger: "ADULT_1" },
    operations: [trainGrades, cities, od].map(operationEvidence),
    trainNumbers,
    itineraries,
    evidenceHash: sha256(JSON.stringify({ departureDate, kricServiceDayCode, grade, departure, arrival, itineraries })),
    credentialRedacted: true,
  };
}

async function fetchAll(operation, query, key, fetchImpl) {
  const all = [];
  const rawHashes = [];
  let totalCount = null;
  for (let pageNo = 1; pageNo <= 100; pageNo += 1) {
    const url = new URL(`${BASE}/${operation}`);
    for (const [name, value] of Object.entries({ serviceKey: key, _type: "json", pageNo: String(pageNo), numOfRows: "100", ...query })) {
      url.searchParams.set(name, String(value));
    }
    const response = await fetchWithRetry(url, fetchImpl);
    if (!response.ok) throw new Error(`TAGO ${operation} HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") throw new Error(`TAGO ${operation} schema mismatch: content-type`);
    const raw = await response.text();
    rawHashes.push(sha256(raw));
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(`TAGO ${operation} schema mismatch: invalid JSON`); }
    const root = json.response ?? json;
    const code = String(root?.header?.resultCode ?? "");
    if (code !== "00") throw new Error(`TAGO ${operation} provider resultCode ${safeCode(code)}`);
    const body = root?.body;
    if (!body || typeof body !== "object") throw new Error(`TAGO ${operation} schema mismatch: body`);
    const items = body.items?.item;
    const rows = items == null ? [] : Array.isArray(items) ? items : [items];
    if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error(`TAGO ${operation} schema mismatch: item`);
    }
    if (body.totalCount === undefined || body.totalCount === null || body.totalCount === "") {
      throw new Error(`TAGO ${operation} schema mismatch: totalCount`);
    }
    const pageTotal = Number(body.totalCount);
    if (!Number.isInteger(pageTotal) || pageTotal < 0 || (totalCount !== null && totalCount !== pageTotal)) {
      throw new Error(`TAGO ${operation} schema mismatch: totalCount`);
    }
    totalCount ??= pageTotal;
    all.push(...rows);
    if (all.length >= totalCount) break;
    if (rows.length === 0) throw new Error(`TAGO ${operation} pagination incomplete`);
  }
  if (all.length !== totalCount) throw new Error(`TAGO ${operation} pagination incomplete`);
  return { operation, endpoint: `${BASE}/${operation}`, pageCount: rawHashes.length, totalCount, rawResponseSha256: sha256(rawHashes.join("|")), rows: all };
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
      if (attempt === 1) throw new Error("TAGO transport failure", { cause: error });
    }
  }
  throw new Error("TAGO transport failure");
}

function uniqueStation(rows, name) {
  const matches = rows.filter((row) => normalize(row.nodename) === normalize(name));
  if (matches.length !== 1) throw new Error(`TAGO station mapping is missing or ambiguous: ${name}`);
  requiredString(matches[0].nodeid, `${name}.nodeid`);
  return matches[0];
}

function stationMapping(row, name) {
  return { providerStationId: row.nodeid, providerStationName: row.nodename, canonicalStationId: CANONICAL_STATIONS[name] };
}

function normalizeItinerary(row, index, expected = {}) {
  if (normalize(row.traingradename) !== "itx청춘") throw new Error(`TAGO OD row[${index}] train grade mismatch`);
  const departureAt = providerTimestamp(row.depplandtime, `row[${index}].depplandtime`);
  const arrivalAt = providerTimestamp(row.arrplandtime, `row[${index}].arrplandtime`);
  if (arrivalAt.epoch <= departureAt.epoch) throw new Error(`TAGO OD row[${index}] arrival must follow departure`);
  const departureStationName = requiredString(row.depplacename, `row[${index}].depplacename`);
  const arrivalStationName = requiredString(row.arrplacename, `row[${index}].arrplacename`);
  if (expected.serviceDate && String(row.depplandtime).slice(0, 8) !== expected.serviceDate) {
    throw new Error(`TAGO OD row[${index}] departure date mismatch`);
  }
  if ((expected.departureStationName && normalize(departureStationName) !== normalize(expected.departureStationName))
    || (expected.arrivalStationName && normalize(arrivalStationName) !== normalize(expected.arrivalStationName))) {
    throw new Error(`TAGO OD row[${index}] station mismatch`);
  }
  const fare = Number(row.adultcharge);
  if (!Number.isInteger(fare) || fare < 0) throw new Error(`TAGO OD row[${index}] adultcharge is invalid`);
  return {
    trainNumber: requiredString(String(row.trainno), `row[${index}].trainno`),
    trainType: "ITX_CHEONGCHUN",
    departureStationName,
    arrivalStationName,
    departureAt: departureAt.iso,
    arrivalAt: arrivalAt.iso,
    adultFareWon: fare,
  };
}

function providerTimestamp(value, label) {
  const text = requiredString(String(value), label);
  if (!/^\d{14}$/.test(text)) throw new Error(`${label} must be YYYYMMDDHHMISS`);
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+09:00`;
  const epoch = Date.parse(iso);
  if (!Number.isFinite(epoch)) throw new Error(`${label} is invalid`);
  return { iso, epoch };
}

function kstDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function calendarDate(value) {
  if (!/^\d{8}$/.test(value ?? "")) throw new Error("service date must be YYYYMMDD");
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
  const actual = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  if (actual !== value) throw new Error("service date must be a valid calendar date");
  return date;
}

function validateServiceDay(value, dayCd) {
  const date = calendarDate(value);
  const weekday = date.getUTCDay();
  const expectedDay = dayCd === "8" ? "weekday" : dayCd === "7" ? "Saturday" : "Sunday";
  const validDay = dayCd === "8" ? weekday >= 1 && weekday <= 5 : weekday === (dayCd === "7" ? 6 : 0);
  if (!validDay) throw new Error(`dayCd ${dayCd} must be a ${expectedDay}`);
  return date;
}

function operationEvidence({ operation, endpoint, pageCount, totalCount, rawResponseSha256 }) {
  return { operation, endpoint, pageCount, totalCount, providerResultCode: "00", schemaStatus: "EXPECTED", rawResponseSha256 };
}

function decodedServiceKey(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalize(value) { return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]+/gu, ""); }
function requiredString(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`); return value; }
function safeCode(value) { return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : "UNKNOWN"; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function naturalCompare(left, right) { return left.localeCompare(right, "ko", { numeric: true }); }
function parseArgs(argv) { const result = {}; for (let i = 0; i < argv.length; i += 2) result[argv[i]?.replace(/^--/, "")] = argv[i + 1]; return result; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = requiredString(args.output, "--output");
  if (!path.isAbsolute(output)) throw new Error("--output must be absolute");
  const artifact = await collectTagoItxCheongchunOd({
    serviceKey: process.env.DATA_GO_KR_SERVICE_KEY,
    departureDate: args.date,
    kricServiceDayCode: args["kric-day-cd"],
  });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  console.log(`sanitized TAGO ITX-청춘 OD evidence ready: trains=${artifact.trainNumbers.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "TAGO ITX probe failed"); process.exitCode = 1; });
}
