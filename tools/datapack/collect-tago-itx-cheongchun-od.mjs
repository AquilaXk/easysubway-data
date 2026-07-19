#!/usr/bin/env node
// 실행 시 --date YYYY-MM-DD, 검증된 KRIC 운행일 코드 --kric-day-cd 7|8|9,
// credential 비포함 absolute --output 경로를 함께 전달한다.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = "https://apis.data.go.kr/1613000/TrainInfo";
const DETAIL_URL = "https://www.data.go.kr/data/15098552/openapi.do";
const NON_PAGINATED_OPERATIONS = new Set(["GetVhcleKndList", "GetCtyCodeList"]);
const PAGINATED_OPERATIONS = new Set(["GetCtyAcctoTrainSttnList", "GetStrtpntAlocFndTrainInfo"]);
const TAGO_DAILY_REQUEST_LIMIT = 10_000;
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
  const ordered = (stations ?? []).map(({ providerStationId, canonicalStationId, corridorSequence }) => ({
    providerStationId: requiredString(providerStationId, "providerStationId"),
    stationId: requiredString(canonicalStationId ?? providerStationId, "canonicalStationId"),
    corridorSequence: Number.isInteger(corridorSequence) ? corridorSequence : null,
  })).sort((left, right) => (
    (left.corridorSequence ?? Number.MAX_SAFE_INTEGER) - (right.corridorSequence ?? Number.MAX_SAFE_INTEGER)
      || stringCompare(left.stationId, right.stationId)
  ));
  const providerIds = ordered.map(({ providerStationId }) => providerStationId);
  const stationIds = ordered.map(({ stationId }) => stationId);
  if (providerIds.length < 2 || new Set(providerIds).size !== providerIds.length || new Set(stationIds).size !== stationIds.length) {
    throw new Error("ITX roster stations must be unique and contain at least 2 stations");
  }
  const rows = providerIds.flatMap((depStationId) => providerIds
    .filter((arrStationId) => arrStationId !== depStationId)
    .map((arrStationId) => ({ date, depStationId, arrStationId })));
  const stationByProviderId = new Map(ordered.map((station) => [station.providerStationId, station]));
  const stationMappings = ordered.map(({ stationId, providerStationId }) => (
    [stationId, providerStationId]
  )).sort((left, right) => stringCompare(JSON.stringify(left), JSON.stringify(right)));
  const hashTuples = rows.map(({ depStationId, arrStationId }) => (
    [
      date,
      stationByProviderId.get(depStationId).stationId,
      depStationId,
      stationByProviderId.get(arrStationId).stationId,
      arrStationId,
    ]
  )).sort((left, right) => stringCompare(JSON.stringify(left), JSON.stringify(right)));
  return {
    rows,
    expectedOdCount: providerIds.length * (providerIds.length - 1),
    stationSetHash: sha256(JSON.stringify(stationMappings)),
    odMatrixHash: sha256(JSON.stringify(hashTuples)),
  };
}

export function materializeTagoItxOdRows({
  itineraries,
  corridorStations,
  serviceDate,
  kricServiceDayCode,
}) {
  try {
    return materializeTagoItxOdRowsStrict({
      itineraries, corridorStations, serviceDate, kricServiceDayCode,
    });
  } catch (error) {
    if (error instanceof Error) {
      error.reconstructionSummary = reconstructionFailureSummary(error, itineraries);
    }
    throw error;
  }
}

function materializeTagoItxOdRowsStrict({
  itineraries,
  corridorStations,
  serviceDate,
  kricServiceDayCode,
}) {
  const serviceId = { "8": "weekday-kric", "7": "saturday-kric", "9": "holiday-kric" }[kricServiceDayCode];
  if (serviceId === undefined) throw new Error("kricServiceDayCode must be 7, 8, or 9");
  validateServiceDay(serviceDate, kricServiceDayCode);
  if (!Array.isArray(itineraries) || itineraries.length === 0) {
    throw new Error("TAGO_OD_PAIR_COVERAGE_INCOMPLETE: no itineraries");
  }
  if (!Array.isArray(corridorStations) || corridorStations.length < 2) {
    throw new Error("TAGO_OD_STOP_SEQUENCE_INVALID: corridor stations");
  }

  const stationsById = new Map();
  for (const [index, station] of corridorStations.entries()) {
    const stationId = requiredString(station?.stationId, `corridorStations[${index}].stationId`);
    const nameKo = requiredString(station?.nameKo, `corridorStations[${index}].nameKo`);
    const corridorSequence = Number(station?.corridorSequence);
    const lineId = requiredString(station?.lineId, `corridorStations[${index}].lineId`);
    if (!Number.isInteger(corridorSequence) || corridorSequence <= 0 || stationsById.has(stationId)
      || !["line-6e39be0cb6e2", "line-54a7b980b7c3"].includes(lineId)) {
      throw new Error("TAGO_OD_STOP_SEQUENCE_INVALID: corridor stations");
    }
    stationsById.set(stationId, { stationId, nameKo, corridorSequence, lineId });
  }

  const grouped = new Map();
  const uniqueOdKeys = new Set();
  for (const [index, itinerary] of itineraries.entries()) {
    const trainNumber = normalizeTrainNumber(itinerary?.trainNumber);
    let departureStationId;
    let arrivalStationId;
    try {
      departureStationId = requiredString(itinerary?.departureStationId, `itineraries[${index}].departureStationId`);
      arrivalStationId = requiredString(itinerary?.arrivalStationId, `itineraries[${index}].arrivalStationId`);
    } catch {
      throw new Error(`TAGO_OD_STOP_SEQUENCE_INVALID: ${trainNumber}`);
    }
    if (!stationsById.has(departureStationId) || !stationsById.has(arrivalStationId)) {
      throw new Error(`TAGO_OD_STOP_SEQUENCE_INVALID: ${trainNumber}`);
    }
    const key = JSON.stringify([serviceDate, trainNumber, departureStationId, arrivalStationId]);
    if (uniqueOdKeys.has(key)) {
      throw reconstructionError(`TAGO_OD_DUPLICATE: ${trainNumber}`, { duplicateOdCount: 1 });
    }
    uniqueOdKeys.add(key);
    const rows = grouped.get(trainNumber) ?? [];
    if (typeof itinerary?.departureAt !== "string" || itinerary.departureAt === ""
      || typeof itinerary?.arrivalAt !== "string" || itinerary.arrivalAt === "") {
      throw reconstructionError(`TAGO_OD_TIME_CONFLICT: ${trainNumber}`, { conflictingTimestampCount: 1 });
    }
    rows.push({
      trainNumber,
      departureStationId,
      arrivalStationId,
      departureAt: itinerary.departureAt,
      arrivalAt: itinerary.arrivalAt,
    });
    grouped.set(trainNumber, rows);
  }

  const trainNumbers = [...grouped.keys()].sort(naturalCompare);
  const stationSequences = [];
  const transitTrips = [];
  const transitStopTimes = [];
  for (const trainNumber of trainNumbers) {
    const rows = grouped.get(trainNumber);
    const signs = new Set(rows.map((row) => Math.sign(
      stationsById.get(row.arrivalStationId).corridorSequence
        - stationsById.get(row.departureStationId).corridorSequence,
    )));
    if (signs.size !== 1 || signs.has(0)) throw new Error(`TAGO_OD_STOP_SEQUENCE_INVALID: ${trainNumber}`);
    const directionId = signs.has(1) ? "up" : "down";
    const stopIds = [...new Set(rows.flatMap(({ departureStationId, arrivalStationId }) => (
      [departureStationId, arrivalStationId]
    )))].sort((left, right) => {
      const difference = stationsById.get(left).corridorSequence - stationsById.get(right).corridorSequence;
      return (directionId === "up" ? difference : -difference) || naturalCompare(left, right);
    });
    if (stopIds.length < 2) throw new Error(`TAGO_OD_STOP_SEQUENCE_INVALID: ${trainNumber}`);
    const usedSequences = stopIds.map((stationId) => stationsById.get(stationId).corridorSequence);
    if (new Set(usedSequences).size !== usedSequences.length) {
      throw new Error(`TAGO_OD_STOP_SEQUENCE_INVALID: ${trainNumber}`);
    }

    const pairByEndpoints = new Map(rows.map((row) => [
      `${row.departureStationId}\u0000${row.arrivalStationId}`,
      row,
    ]));
    const missingPairs = [];
    for (let from = 0; from < stopIds.length - 1; from += 1) {
      for (let to = from + 1; to < stopIds.length; to += 1) {
        if (!pairByEndpoints.has(`${stopIds[from]}\u0000${stopIds[to]}`)) {
          missingPairs.push([stopIds[from], stopIds[to]]);
        }
      }
    }
    const expectedPairCount = stopIds.length * (stopIds.length - 1) / 2;
    if (missingPairs.length > 0 || rows.length !== expectedPairCount) {
      throw reconstructionError(`TAGO_OD_PAIR_COVERAGE_INCOMPLETE: ${trainNumber}`, {
        missingPairCount: Math.max(missingPairs.length, expectedPairCount - rows.length),
      });
    }

    const stops = stopIds.map((stationId, index) => {
      const arrivals = new Set(rows.filter((row) => row.arrivalStationId === stationId).map(({ arrivalAt }) => arrivalAt));
      const departures = new Set(rows.filter((row) => row.departureStationId === stationId).map(({ departureAt }) => departureAt));
      if (arrivals.size > 1 || departures.size > 1
        || (index > 0 && arrivals.size !== 1)
        || (index < stopIds.length - 1 && departures.size !== 1)) {
        throw reconstructionError(`TAGO_OD_TIME_CONFLICT: ${trainNumber}`, { conflictingTimestampCount: 1 });
      }
      const arrivalAt = index === 0 ? [...departures][0] : [...arrivals][0];
      const departureAt = index === stopIds.length - 1 ? [...arrivals][0] : [...departures][0];
      const arrivalSeconds = tagoServiceSeconds(arrivalAt, serviceDate, trainNumber);
      const departureSeconds = tagoServiceSeconds(departureAt, serviceDate, trainNumber);
      if (arrivalSeconds > departureSeconds) throw new Error(`TAGO_OD_STOP_SEQUENCE_INVALID: ${trainNumber}`);
      const station = stationsById.get(stationId);
      return { ...station, arrivalAt, departureAt, arrivalSeconds, departureSeconds };
    });
    for (let index = 1; index < stops.length; index += 1) {
      if (stops[index - 1].departureSeconds > stops[index].arrivalSeconds) {
        throw new Error(`TAGO_OD_STOP_SEQUENCE_INVALID: ${trainNumber}`);
      }
    }
    for (let from = 0; from < stops.length - 1; from += 1) {
      for (let to = from + 1; to < stops.length; to += 1) {
        const pair = pairByEndpoints.get(`${stops[from].stationId}\u0000${stops[to].stationId}`);
        if (pair.departureAt !== stops[from].departureAt || pair.arrivalAt !== stops[to].arrivalAt) {
          throw reconstructionError(`TAGO_OD_TIME_CONFLICT: ${trainNumber}`, { conflictingTimestampCount: 1 });
        }
      }
    }

    const routeId = `route-line-54a7b980b7c3-${directionId}`;
    const tripId = `${routeId}-${trainNumber}-${kricServiceDayCode}`;
    transitTrips.push({
      id: tripId,
      routeId,
      serviceId,
      tripHeadsign: stops.at(-1).nameKo,
      directionId,
      servicePattern: "EXPRESS",
      trainNo: trainNumber,
    });
    stops.forEach((stop, index) => transitStopTimes.push({
      tripId,
      stopSequence: index + 1,
      stationId: stop.stationId,
      lineId: stop.lineId,
      arrivalSeconds: stop.arrivalSeconds,
      departureSeconds: stop.departureSeconds,
    }));
    stationSequences.push({
      trainNumber,
      directionId,
      originStationName: stops[0].nameKo,
      destinationStationName: stops.at(-1).nameKo,
      terminalVariant: `${stops[0].nameKo}→${stops.at(-1).nameKo}`,
      observedOdCount: rows.length,
      stopCount: stops.length,
      conflictingTimestampCount: 0,
      missingPairCount: 0,
      duplicateOdCount: 0,
      stops: stops.map((stop, index) => ({ ...stop, stopSequence: index + 1 })),
    });
  }

  transitTrips.sort((left, right) => stringCompare(left.id, right.id));
  transitStopTimes.sort((left, right) => stringCompare(left.tripId, right.tripId) || left.stopSequence - right.stopSequence);
  return {
    trainNumbers,
    stationSequences,
    transitTrips,
    transitStopTimes,
    reconstructionSummary: {
      trainCount: trainNumbers.length,
      stopCount: transitStopTimes.length,
      conflictingTimestampCount: 0,
      missingPairCount: 0,
      duplicateOdCount: 0,
    },
  };
}

export function normalizeTrainNumber(value) {
  const match = /^(?:ITX-)?(\d+)$/.exec(String(value ?? ""));
  const digits = match?.[1].replace(/^0+/, "") ?? "";
  if (digits === "") throw new Error("invalid train number");
  return digits;
}

export async function collectTagoItxCheongchunRoster({
  serviceKey,
  serviceDate,
  kricServiceDayCode,
  canonicalStations,
  fetchImpl = fetch,
  now = new Date(),
  requestBudget = { limit: TAGO_DAILY_REQUEST_LIMIT, remaining: TAGO_DAILY_REQUEST_LIMIT },
  waitImpl = wait,
} = {}) {
  const key = decodedServiceKey(requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  if (!["7", "8", "9"].includes(kricServiceDayCode)) throw new Error("kricServiceDayCode must be 7, 8, or 9");
  validateServiceDay(serviceDate, kricServiceDayCode);
  if (!Array.isArray(canonicalStations) || canonicalStations.length < 2) throw new Error("canonicalStations must contain at least 2 stations");
  const canonicalIds = new Set();
  for (const station of canonicalStations) {
    const canonicalStationId = requiredString(station?.canonicalStationId, "canonicalStations.canonicalStationId");
    requiredString(station?.nameKo, "canonicalStations.nameKo");
    if (canonicalIds.has(canonicalStationId)
      || !Number.isInteger(station?.corridorSequence) || station.corridorSequence <= 0
      || !["line-6e39be0cb6e2", "line-54a7b980b7c3"].includes(station?.lineId)) {
      throw new Error("canonicalStations corridor metadata is invalid");
    }
    canonicalIds.add(canonicalStationId);
  }
  if (!Number.isInteger(requestBudget?.limit) || requestBudget.limit <= 0
    || requestBudget.limit > TAGO_DAILY_REQUEST_LIMIT
    || !Number.isInteger(requestBudget.remaining) || requestBudget.remaining < 0
    || requestBudget.remaining > requestBudget.limit) {
    throw new Error("requestBudget must stay within the 10000-request daily limit");
  }

  const trainGrades = await fetchAll("GetVhcleKndList", {}, key, fetchImpl, requestBudget, waitImpl);
  const gradeRows = trainGrades.rows.filter((row) => normalize(row.vehiclekndnm) === "itx청춘");
  if (gradeRows.length !== 1) throw new Error("TAGO ITX-청춘 train grade is missing or ambiguous");
  const grade = gradeRows[0];
  const gradeId = requiredString(grade.vehiclekndid, "vehiclekndid");
  const cities = await fetchAll("GetCtyCodeList", {}, key, fetchImpl, requestBudget, waitImpl);
  const stationOperations = [];
  const stationRows = [];
  for (const city of cities.rows) {
    const operation = await fetchAll("GetCtyAcctoTrainSttnList", {
      cityCode: requiredString(city.citycode, "citycode"),
    }, key, fetchImpl, requestBudget, waitImpl);
    stationOperations.push(operation);
    stationRows.push(...operation.rows);
  }
  const stations = [];
  const excludedCanonicalStations = [];
  for (const { canonicalStationId, nameKo, corridorSequence, lineId } of canonicalStations) {
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
      nameKo: canonicalName,
      corridorSequence: Number(corridorSequence),
      lineId: requiredString(lineId, `${canonicalName}.lineId`),
    });
  }
  const requiredStationNames = ["용산", "옥수", "왕십리", "청량리", "춘천"];
  const excludedRequired = requiredStationNames.filter((name) => (
    canonicalStations.some((station) => normalize(station.nameKo) === normalize(name))
      && !stations.some((station) => normalize(station.nameKo) === normalize(name))
  ));
  if (excludedRequired.length > 0) {
    throw new Error(`TAGO required station mapping is incomplete: ${excludedRequired.map(safeLabel).join(",")}`);
  }
  stations.sort((left, right) => left.corridorSequence - right.corridorSequence
    || stringCompare(left.canonicalStationId, right.canonicalStationId));
  const matrix = buildItxOdMatrix(serviceDate, stations);
  const catalogRequestCount = [trainGrades, cities, ...stationOperations]
    .reduce((total, operation) => total + operation.requestCount, 0);
  const remainingInitialRequestBudget = requestBudget.remaining;
  const initialOdRequestCount = matrix.expectedOdCount;
  if (initialOdRequestCount > remainingInitialRequestBudget) {
    throw new Error("TAGO_QUOTA_BUDGET_EXHAUSTED");
  }
  const stationByProviderId = new Map(stations.map((station) => [station.providerStationId, station]));
  const odOperations = [];
  const itineraries = [];
  const failedOds = [];
  for (const { depStationId, arrStationId } of matrix.rows) {
    const departureStation = stationByProviderId.get(depStationId);
    const arrivalStation = stationByProviderId.get(arrStationId);
    const remainingBeforeOd = requestBudget.remaining;
    try {
      const operation = await fetchAll("GetStrtpntAlocFndTrainInfo", {
        depPlaceId: depStationId,
        arrPlaceId: arrStationId,
        depPlandTime: serviceDate,
        trainGradeCode: gradeId,
      }, key, fetchImpl, requestBudget, waitImpl);
      const normalizedRows = operation.rows.map((row, index) => ({
        itinerary: {
          ...normalizeItinerary(row, index, {
          departureStationName: departureStation.providerStationName,
          arrivalStationName: arrivalStation.providerStationName,
          }),
          departureStationId: departureStation.canonicalStationId,
          arrivalStationId: arrivalStation.canonicalStationId,
        },
        ...tagoServiceDayPartition(row.depplandtime),
      }));
      const normalizedItineraries = normalizedRows.flatMap(({ itinerary, calendarDay, serviceDay }, index) => {
        if (serviceDay === serviceDate) return [itinerary];
        if (calendarDay === serviceDate) return [];
        throw new Error(`TAGO OD row[${index}] departure date mismatch`);
      });
      odOperations.push(operation);
      itineraries.push(...normalizedItineraries);
    } catch (error) {
      if (error instanceof Error && error.message === "TAGO_QUOTA_BUDGET_EXHAUSTED") throw error;
      const failure = tagoOdFailure(error);
      failedOds.push({
        departureStationId: departureStation.canonicalStationId,
        arrivalStationId: arrivalStation.canonicalStationId,
        requestCount: remainingBeforeOd - requestBudget.remaining,
        ...failure,
      });
    }
  }
  const trainNumbers = [...new Set(itineraries.map(({ trainNumber }) => normalizeTrainNumber(trainNumber)))].sort(naturalCompare);
  if (trainNumbers.length === 0 && failedOds.length === 0) throw new Error("TAGO ITX-청춘 roster returned zero rows");
  const buildArtifact = (materialized, reconstructionSummary = null) => {
    const odRequestCount = remainingInitialRequestBudget - requestBudget.remaining;
    const failedOdRequestCount = failedOds.reduce((total, { requestCount }) => total + requestCount, 0);
    const artifact = {
      schemaVersion: 2,
      artifactKind: "tago-itx-cheongchun-roster-evidence",
      serviceId: "ITX_CHEONGCHUN",
      officialSourceUrl: DETAIL_URL,
      observedAt: now.toISOString(),
      serviceDate,
      kricServiceDayCode,
      trainGrade: { code: gradeId, name: grade.vehiclekndnm, serviceId: "ITX_CHEONGCHUN" },
      canonicalStationCount: canonicalStations.length,
      rosterStationCount: stations.length,
      excludedCanonicalStations: excludedCanonicalStations.sort((left, right) => naturalCompare(left.nameKo, right.nameKo)),
      stations,
      expectedOdCount: matrix.expectedOdCount,
      completedOdCount: odOperations.length,
      failedOdCount: failedOds.length,
      ...(failedOds.length > 0 ? { failedOds } : {}),
      stationSetHash: matrix.stationSetHash,
      odMatrixHash: matrix.odMatrixHash,
      quotaSummary: {
        catalogRequestCount,
        remainingInitialRequestBudget,
        initialOdRequestCount,
        odRequestCount,
        failedOdRequestCount,
        actualRequestCount: catalogRequestCount + odRequestCount,
      },
      operations: [trainGrades, cities, ...stationOperations, ...odOperations].map(operationEvidence),
      trainNumbers: materialized?.trainNumbers ?? trainNumbers,
      itineraries,
      ...(materialized ? materialized : {}),
      ...(!materialized && reconstructionSummary ? { reconstructionSummary } : {}),
      credentialRedacted: true,
    };
    artifact.evidenceHash = sha256(JSON.stringify(artifact));
    return artifact;
  };
  if (failedOds.length > 0) return buildArtifact(null);
  try {
    return buildArtifact(materializeTagoItxOdRows({
      itineraries,
      corridorStations: stations.map(({ canonicalStationId, nameKo, corridorSequence, lineId }) => ({
        stationId: canonicalStationId, nameKo, corridorSequence, lineId,
      })),
      serviceDate,
      kricServiceDayCode,
    }));
  } catch (error) {
    if (error instanceof Error) error.rosterEvidence = buildArtifact(null, error.reconstructionSummary);
    throw error;
  }
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

async function fetchAll(operation, query, key, fetchImpl, requestBudget = null, waitImpl = wait) {
  const paginated = PAGINATED_OPERATIONS.has(operation);
  if (!paginated && !NON_PAGINATED_OPERATIONS.has(operation)) {
    throw new Error(`TAGO operation is unsupported: ${safeCode(operation)}`);
  }
  const all = [];
  const rawHashes = [];
  let requestCount = 0;
  let totalCount = null;
  const maxPages = paginated ? 100 : 1;
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const url = new URL(`${BASE}/${operation}`);
    const pagination = paginated ? { pageNo: String(pageNo), numOfRows: "100" } : {};
    for (const [name, value] of Object.entries({ serviceKey: key, _type: "json", ...pagination, ...query })) {
      url.searchParams.set(name, String(value));
    }
    const fetched = await fetchWithRetry(url, fetchImpl, requestBudget, waitImpl);
    const response = fetched.response;
    requestCount += fetched.attemptCount;
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new Error(`TAGO ${operation} HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new Error(`TAGO ${operation} schema mismatch: content-type`);
    }
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
    if (!paginated && (items == null || typeof items !== "object")) {
      throw new Error(`TAGO ${operation} schema mismatch: item`);
    }
    const rows = items == null ? [] : Array.isArray(items) ? items : [items];
    if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error(`TAGO ${operation} schema mismatch: item`);
    }
    if (!paginated) {
      all.push(...rows);
      totalCount = rows.length;
      break;
    }
    if (body.totalCount === undefined || body.totalCount === null || body.totalCount === "") {
      const bodyFields = Object.keys(body)
        .filter((field) => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(field))
        .sort((left, right) => left.localeCompare(right))
        .join(",") || "NONE";
      throw new Error(`TAGO ${operation} schema mismatch: totalCount bodyFields=${bodyFields}`);
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
  return { operation, endpoint: `${BASE}/${operation}`, pageCount: rawHashes.length, requestCount, totalCount, rawResponseSha256: sha256(rawHashes.join("|")), rows: all };
}

async function fetchWithRetry(url, fetchImpl, requestBudget, waitImpl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      if (requestBudget) {
        if (requestBudget.remaining <= 0) throw new Error("TAGO_QUOTA_BUDGET_EXHAUSTED");
        requestBudget.remaining -= 1;
      }
      response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json" },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "TAGO_QUOTA_BUDGET_EXHAUSTED") throw error;
      if (attempt === 2) throw new Error("TAGO transport failure", { cause: error });
      await waitImpl(250 * 2 ** attempt);
      continue;
    }
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) return { response, attemptCount: attempt + 1 };
    if (response.body) await response.body.cancel().catch(() => {});
    await waitImpl(250 * 2 ** attempt);
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
  if ((expected.departureStationName && normalize(departureStationName) !== normalize(expected.departureStationName))
    || (expected.arrivalStationName && normalize(arrivalStationName) !== normalize(expected.arrivalStationName))) {
    throw new Error(`TAGO OD row[${index}] station mismatch`);
  }
  const fare = Number(row.adultcharge);
  if (!Number.isInteger(fare) || fare < 0) throw new Error(`TAGO OD row[${index}] adultcharge is invalid`);
  return {
    trainNumber: normalizeTrainNumber(row.trainno),
    trainType: "ITX_CHEONGCHUN",
    departureStationName,
    arrivalStationName,
    departureAt: departureAt.iso,
    arrivalAt: arrivalAt.iso,
    adultFareWon: fare,
  };
}

function tagoServiceDayPartition(value) {
  const text = String(value ?? "");
  const calendarDay = text.slice(0, 8);
  const serviceDayDate = calendarDate(calendarDay);
  if (Number(text.slice(8, 10)) < 3) serviceDayDate.setUTCDate(serviceDayDate.getUTCDate() - 1);
  const serviceDay = `${serviceDayDate.getUTCFullYear()}${String(serviceDayDate.getUTCMonth() + 1).padStart(2, "0")}${String(serviceDayDate.getUTCDate()).padStart(2, "0")}`;
  return { calendarDay, serviceDay };
}

function providerTimestamp(value, label) {
  const text = requiredString(String(value), label);
  if (!/^\d{14}$/.test(text)) throw new Error(`${label} must be YYYYMMDDHHMISS`);
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+09:00`;
  const epoch = Date.parse(iso);
  if (!Number.isFinite(epoch)) throw new Error(`${label} is invalid`);
  return { iso, epoch };
}

function tagoServiceSeconds(value, serviceDate, trainNumber) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+09:00$/.exec(String(value ?? ""));
  if (!match) {
    throw reconstructionError(`TAGO_OD_TIME_CONFLICT: ${trainNumber}`, { conflictingTimestampCount: 1 });
  }
  const timestampDate = `${match[1]}${match[2]}${match[3]}`;
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw reconstructionError(`TAGO_OD_TIME_CONFLICT: ${trainNumber}`, { conflictingTimestampCount: 1 });
  }
  const next = calendarDate(serviceDate);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextServiceDate = `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, "0")}${String(next.getUTCDate()).padStart(2, "0")}`;
  const offset = timestampDate === serviceDate ? 0 : timestampDate === nextServiceDate && hours <= 2 ? 86_400 : null;
  if (offset === null) throw new Error(`TAGO_OD_STOP_SEQUENCE_INVALID: ${trainNumber}`);
  return offset + hours * 3600 + minutes * 60 + seconds;
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

function operationEvidence({ operation, endpoint, pageCount, requestCount, totalCount, rawResponseSha256 }) {
  return { operation, endpoint, pageCount, requestCount, totalCount, providerResultCode: "00", schemaStatus: "EXPECTED", rawResponseSha256 };
}

function tagoOdFailure(error) {
  const message = error instanceof Error ? error.message : "";
  const httpStatus = /^TAGO GetStrtpntAlocFndTrainInfo HTTP (\d{3})$/.exec(message)?.[1];
  if (httpStatus) {
    return {
      reasonCode: "PROVIDER_HTTP_FAILURE",
      failureContext: `operation=GetStrtpntAlocFndTrainInfo,httpStatus=${httpStatus}`,
    };
  }
  const schema = /^TAGO GetStrtpntAlocFndTrainInfo schema mismatch: (content-type|invalid JSON|body|item|totalCount)(?: bodyFields=([A-Za-z0-9_,.-]+))?$/.exec(message);
  if (schema) {
    const reason = schema[1] === "invalid JSON" ? "invalid-json" : schema[1];
    return {
      reasonCode: "PROVIDER_SCHEMA_FAILURE",
      failureContext: `operation=GetStrtpntAlocFndTrainInfo,reason=schema_mismatch,${reason}`
        + (schema[2] ? `,bodyFields=${schema[2]}` : ""),
    };
  }
  if (/^TAGO transport failure$/.test(message)) {
    return { reasonCode: "PROVIDER_TRANSPORT_FAILURE", failureContext: "operation=GetStrtpntAlocFndTrainInfo" };
  }
  if (/provider resultCode/.test(message)) {
    return { reasonCode: "PROVIDER_RESULT_FAILURE", failureContext: "operation=GetStrtpntAlocFndTrainInfo" };
  }
  if (/pagination incomplete/.test(message)) {
    return {
      reasonCode: "PROVIDER_PAGINATION_INCOMPLETE",
      failureContext: "operation=GetStrtpntAlocFndTrainInfo,reason=pagination_incomplete",
    };
  }
  for (const [pattern, reason] of [
    [/station mismatch/, "station_mismatch"],
    [/departure date mismatch/, "date_mismatch"],
    [/train grade mismatch/, "train_grade_mismatch"],
    [/arrival must follow departure/, "time_order_mismatch"],
    [/must be YYYYMMDDHHMISS|is invalid|adultcharge is invalid|invalid train number/, "field_contract_mismatch"],
  ]) {
    if (pattern.test(message)) {
      return {
        reasonCode: "PROVIDER_SCHEMA_FAILURE",
        failureContext: `operation=GetStrtpntAlocFndTrainInfo,reason=${reason}`,
      };
    }
  }
  return { reasonCode: "PROVIDER_OR_SCHEMA_FAILURE", failureContext: "operation=GetStrtpntAlocFndTrainInfo" };
}

function decodedServiceKey(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

function reconstructionFailureSummary(error, itineraries) {
  const trainCount = new Set((Array.isArray(itineraries) ? itineraries : []).flatMap((itinerary) => {
    try { return [normalizeTrainNumber(itinerary?.trainNumber)]; } catch { return []; }
  })).size;
  const counts = error?.reconstructionCounts ?? {};
  return {
    trainCount,
    stopCount: 0,
    conflictingTimestampCount: reportedCount(counts.conflictingTimestampCount),
    missingPairCount: reportedCount(counts.missingPairCount),
    duplicateOdCount: reportedCount(counts.duplicateOdCount),
  };
}

function reconstructionError(message, counts) {
  const error = new Error(message);
  error.reconstructionCounts = counts;
  return error;
}

function reportedCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalize(value) { return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]+/gu, ""); }
function requiredString(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`); return value; }
function safeCode(value) { return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : "UNKNOWN"; }
function safeLabel(value) { const text = String(value ?? "").normalize("NFC"); return /^[\p{L}\p{N}._-]{1,32}$/u.test(text) ? text : "UNKNOWN"; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function naturalCompare(left, right) { return left.localeCompare(right, "ko", { numeric: true }); }
function stringCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
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
