
import { canonicalJson } from "./manifest-validation.mjs";
import { sha256 } from "../../lib/hash.mjs";

// 광주 1호선(S2901)·대전 1호선(S3001) 시간표는 원장 head가 결속한 KRIC 보관본(kric-nationwide-timetable-file,
// retainedScheduleAdmissionEvidence)에서 만든다. 보관본 관측(observation.json, 약 231MB)은 저장소에 두지 않으므로,
// 관측 바이트를 원장 head의 rawObjectSha256으로 확인한 등록 시점에 노선 행만 원문 그대로 골라 projection으로 커밋한다.
// 후보 생성은 이 projection을 내용 해시와 inventory evidence, 현재 보관본 head로 다시 확인한 뒤에만 쓴다.

export const RETAINED_GWANGJU_PROJECTION_SOURCE_ID = "kric-nationwide-timetable-file";
export const RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY = "retainedGwangjuProjectionEvidence";
export const RETAINED_GWANGJU_PROJECTION_KIND = "kric-retained-gwangju-timetable-projection";
export const RETAINED_DAEJEON_PROJECTION_EVIDENCE_KEY = "retainedDaejeonProjectionEvidence";
export const RETAINED_DAEJEON_PROJECTION_KIND = "kric-retained-daejeon-timetable-projection";
export const DAEJEON_ROUTE_NUMBER = "S3001";
export const DAEJEON_LINE_ID = "line-7051a9c2525c";
export const DAEJEON_ROUTE_ID = "route-daejeon-line-1";

const GWANGJU_SNAPSHOT_PREFIX = `${RETAINED_GWANGJU_PROJECTION_SOURCE_ID}-gwangju-`;
const DAEJEON_SNAPSHOT_PREFIX = `${RETAINED_GWANGJU_PROJECTION_SOURCE_ID}-daejeon-`;
const NOON_SECONDS = 12 * 3600;
const MIDNIGHT_SECONDS = 24 * 3600;
const SHA256 = /^[a-f0-9]{64}$/u;

const DAEJEON_SERVICE_BY_WEEKDAY = new Map([
  ["평일", { serviceId: "daejeon-weekday-2026", sortOrder: 0 }],
  ["휴일", { serviceId: "daejeon-holiday-2026", sortOrder: 1 }],
]);

const failWithPrefix = (prefix, code, detail = "") => {
  throw new Error(`${prefix}_${code}${detail ? `: ${detail}` : ""}`);
};

function buildProjectionContent({ artifactKind, retainedEvidence, observationRawObjectSha256, routeNumber, records }) {
  return {
    schemaVersion: 1,
    artifactKind,
    sourceId: RETAINED_GWANGJU_PROJECTION_SOURCE_ID,
    retainedSnapshotId: retainedEvidence.snapshotId,
    observedAt: retainedEvidence.observedAt,
    observationRecordsSha256: retainedEvidence.recordsSha256,
    observationRawObjectSha256,
    routeNumber,
    recordCount: records.length,
    recordsSha256: sha256(`${JSON.stringify(records)}\n`),
    records,
  };
}

function projectRetainedLineRecords({
  artifactKind,
  snapshotPrefix,
  errorPrefix,
  retained,
  retainedEvidence,
  observationRawObjectSha256,
}) {
  if (
    !retained?.observation
    || !Array.isArray(retained.observation.records)
    || typeof retained.routeNumber !== "string"
    || typeof retainedEvidence?.snapshotId !== "string"
    || typeof retainedEvidence.observedAt !== "string"
    || !SHA256.test(retainedEvidence.recordsSha256 ?? "")
    || !SHA256.test(observationRawObjectSha256 ?? "")
  ) {
    failWithPrefix(errorPrefix, "INPUT");
  }
  const targetRouteNumber = retained.routeNumber;
  const records = [];
  for (const record of retained.observation.records) {
    if (record?.routeNumber === targetRouteNumber) {
      records.push(record);
    }
  }
  records.sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
  if (records.length === 0) {
    failWithPrefix(errorPrefix, "ROUTE_EMPTY", targetRouteNumber);
  }
  const value = buildProjectionContent({
    artifactKind,
    retainedEvidence,
    observationRawObjectSha256,
    routeNumber: targetRouteNumber,
    records,
  });
  const contentSha256 = sha256(canonicalJson(value));
  return { snapshotId: `${snapshotPrefix}${contentSha256}`, contentSha256, ...value };
}

function buildProjectionEvidence(snapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`,
    contentSha256: snapshot.contentSha256,
    retainedSnapshotId: snapshot.retainedSnapshotId,
    observationRawObjectSha256: snapshot.observationRawObjectSha256,
    routeNumber: snapshot.routeNumber,
    recordCount: snapshot.recordCount,
    recordsSha256: snapshot.recordsSha256,
  };
}

function validateRetainedLineProjection({
  artifactKind,
  snapshotPrefix,
  errorPrefix,
  snapshot,
  evidence,
  retainedEvidence,
  retainedHead,
}) {
  const { snapshotId, contentSha256, ...value } = snapshot ?? {};
  if (
    value.schemaVersion !== 1
    || value.artifactKind !== artifactKind
    || value.sourceId !== RETAINED_GWANGJU_PROJECTION_SOURCE_ID
    || !Array.isArray(value.records)
    || value.recordCount !== value.records.length
    || value.recordsSha256 !== sha256(`${JSON.stringify(value.records)}\n`)
    || value.records.some((record) => record?.routeNumber !== value.routeNumber)
    || contentSha256 !== sha256(canonicalJson(value))
    || snapshotId !== `${snapshotPrefix}${contentSha256}`
  ) {
    failWithPrefix(errorPrefix, "CONTENT");
  }
  if (canonicalJson(evidence ?? null) !== canonicalJson(buildProjectionEvidence(snapshot))) {
    failWithPrefix(errorPrefix, "EVIDENCE");
  }
  if (
    value.retainedSnapshotId !== retainedEvidence?.snapshotId
    || value.observedAt !== retainedEvidence.observedAt
    || value.observationRecordsSha256 !== retainedEvidence.recordsSha256
  ) {
    failWithPrefix(errorPrefix, "STALE", value.retainedSnapshotId);
  }
  if (
    retainedHead?.snapshotId !== value.retainedSnapshotId
    || !SHA256.test(retainedHead.rawObjectSha256 ?? "")
    || value.observationRawObjectSha256 !== retainedHead.rawObjectSha256
  ) {
    failWithPrefix(errorPrefix, "LEDGER", value.retainedSnapshotId);
  }
  return snapshot;
}

/**
 * restoreAdmittedGwangjuTimetable이 원장 head와 결속을 확인한 보관본(계약 + 관측)에서 계약 노선 행만 고른다.
 * @param {{ retained: { observation: { records: object[] }, routeNumber: string }, retainedEvidence: object, observationRawObjectSha256: string }} input
 */
export function projectRetainedGwangjuRecords({ retained, retainedEvidence, observationRawObjectSha256 }) {
  return projectRetainedLineRecords({
    artifactKind: RETAINED_GWANGJU_PROJECTION_KIND,
    snapshotPrefix: GWANGJU_SNAPSHOT_PREFIX,
    errorPrefix: "RETAINED_GWANGJU_PROJECTION",
    retained,
    retainedEvidence,
    observationRawObjectSha256,
  });
}

/** inventory에 남길 광주 projection evidence(스냅샷 경로·내용 해시·보관본 head 결속). */
export function retainedGwangjuProjectionEvidence(snapshot) {
  return buildProjectionEvidence(snapshot);
}

/**
 * 광주 projection 자기 결속, inventory evidence 결속, 현재 보관본 head 결속을 모두 확인한다.
 */
export function validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence, retainedHead }) {
  return validateRetainedLineProjection({
    artifactKind: RETAINED_GWANGJU_PROJECTION_KIND,
    snapshotPrefix: GWANGJU_SNAPSHOT_PREFIX,
    errorPrefix: "RETAINED_GWANGJU_PROJECTION",
    snapshot,
    evidence,
    retainedEvidence,
    retainedHead,
  });
}

/**
 * 원장 head와 결속을 확인한 KRIC 보관본 관측에서 대전 도시철도 1호선(S3001) 행만 고른다.
 * @param {{ retained?: { observation: { records: object[] }, routeNumber?: string }, observation?: { records: object[] }, routeNumber?: string, retainedEvidence: object, observationRawObjectSha256: string }} input
 */
export function projectRetainedDaejeonRecords({
  retained,
  observation = retained?.observation,
  routeNumber = retained?.routeNumber ?? DAEJEON_ROUTE_NUMBER,
  retainedEvidence,
  observationRawObjectSha256,
}) {
  return projectRetainedLineRecords({
    artifactKind: RETAINED_DAEJEON_PROJECTION_KIND,
    snapshotPrefix: DAEJEON_SNAPSHOT_PREFIX,
    errorPrefix: "RETAINED_DAEJEON_PROJECTION",
    retained: { observation, routeNumber },
    retainedEvidence,
    observationRawObjectSha256,
  });
}

/** inventory에 남길 대전 projection evidence(스냅샷 경로·내용 해시·보관본 head 결속). */
export function retainedDaejeonProjectionEvidence(snapshot) {
  return buildProjectionEvidence(snapshot);
}

/**
 * 대전 projection 자기 결속, inventory evidence 결속, 현재 보관본 head 결속을 모두 확인한다.
 */
export function validateRetainedDaejeonProjection({ snapshot, evidence, retainedEvidence, retainedHead }) {
  const validated = validateRetainedLineProjection({
    artifactKind: RETAINED_DAEJEON_PROJECTION_KIND,
    snapshotPrefix: DAEJEON_SNAPSHOT_PREFIX,
    errorPrefix: "RETAINED_DAEJEON_PROJECTION",
    snapshot,
    evidence,
    retainedEvidence,
    retainedHead,
  });
  if (validated.routeNumber !== DAEJEON_ROUTE_NUMBER) {
    failWithPrefix("RETAINED_DAEJEON_PROJECTION", "CONTENT", validated.routeNumber);
  }
  return validated;
}

function parseClockSeconds(rawClock, trainNumber) {
  if (typeof rawClock !== "string" || rawClock.length !== 5 || rawClock.charCodeAt(2) !== 58) {
    failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "CLOCK", `${trainNumber}:${rawClock}`);
  }
  const h1 = rawClock.charCodeAt(0) - 48;
  const h2 = rawClock.charCodeAt(1) - 48;
  const m1 = rawClock.charCodeAt(3) - 48;
  const m2 = rawClock.charCodeAt(4) - 48;
  if (h1 < 0 || h1 > 9 || h2 < 0 || h2 > 9 || m1 < 0 || m1 > 9 || m2 < 0 || m2 > 9) {
    failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "CLOCK", `${trainNumber}:${rawClock}`);
  }
  const hours = h1 * 10 + h2;
  const minutes = m1 * 10 + m2;
  if (hours > 23 || minutes > 59) {
    failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "CLOCK", `${trainNumber}:${rawClock}`);
  }
  return hours * 3600 + minutes * 60;
}

function parseDaejeonChainTokens(cell, trainNumber, fieldName) {
  const raw = typeof cell === "string" ? cell : cell?.value;
  if (typeof raw !== "string" || raw.length === 0) {
    failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "CHAIN", `${trainNumber}:${fieldName}`);
  }
  const parts = raw.split("+");
  const values = new Array(parts.length);
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (token.length < 5 || token.charCodeAt(3) !== 45) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "CHAIN_TOKEN", `${trainNumber}:${fieldName}:${token}`);
    }
    const d1 = token.charCodeAt(0) - 48;
    const d2 = token.charCodeAt(1) - 48;
    const d3 = token.charCodeAt(2) - 48;
    if (d1 < 0 || d1 > 9 || d2 < 0 || d2 > 9 || d3 < 0 || d3 > 9) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "CHAIN_SEQ", `${trainNumber}:${fieldName}:${token}`);
    }
    const sequence = d1 * 100 + d2 * 10 + d3;
    if (sequence !== index + 1) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "CHAIN_ORDER", `${trainNumber}:${fieldName}:${sequence}`);
    }
    const payload = token.slice(4).trim();
    if (payload.length === 0) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "CHAIN_EMPTY", `${trainNumber}:${fieldName}:${sequence}`);
    }
    values[index] = payload;
  }
  return values;
}

function normalizeStationLabel(name) {
  return String(name ?? "").replace(/\(.*?\)/gu, "").trim().replace(/역$/u, "");
}

function buildDaejeonStationLookup(finalPack) {
  const stations = finalPack?.stations;
  const stationLines = finalPack?.stationLines;
  if (!Array.isArray(stations) || !Array.isArray(stationLines)) {
    failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "STATIONS_INPUT");
  }
  const lineSequenceByStationId = new Map();
  for (const link of stationLines) {
    if (link?.lineId !== DAEJEON_LINE_ID) continue;
    if (typeof link.stationId !== "string" || !Number.isInteger(link.lineSequence) || lineSequenceByStationId.has(link.stationId)) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "STATION_LINE", link?.stationId ?? "");
    }
    lineSequenceByStationId.set(link.stationId, link.lineSequence);
  }
  if (lineSequenceByStationId.size === 0) {
    failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "LINE_STATIONS_EMPTY");
  }
  const stationByName = new Map();
  for (const station of stations) {
    const stationId = station?.id;
    const lineSequence = lineSequenceByStationId.get(stationId);
    if (lineSequence === undefined) continue;
    const label = normalizeStationLabel(station?.nameKo);
    if (!label || stationByName.has(label)) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "STATION_NAME", stationId ?? "");
    }
    const entry = { id: stationId, nameKo: label, lineSequence };
    stationByName.set(label, entry);
  }
  if (stationByName.size !== lineSequenceByStationId.size) {
    failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "STATION_COUNT_MISMATCH");
  }
  return stationByName;
}

/**
 * 검증된 대전 KRIC projection 레코드에서 정준 transitTrips와 transitStopTimes(시발~종착 공식 시각)를 생성한다.
 */
export function buildRetainedDaejeonScheduleTables({
  records,
  projection,
  retainedEvidence,
  finalPack,
}) {
  const sourceRecords = Array.isArray(records) ? records : projection?.records;
  const evidenceHash = retainedEvidence?.retainedContractSha256 ?? retainedEvidence?.observationIdentitySha256;
  if (
    !Array.isArray(sourceRecords)
    || sourceRecords.length === 0
    || typeof retainedEvidence?.snapshotId !== "string"
    || typeof retainedEvidence.observedAt !== "string"
    || !SHA256.test(evidenceHash ?? "")
  ) {
    failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "INPUT");
  }

  const stationByName = buildDaejeonStationLookup(finalPack);
  const sortedRecords = [...sourceRecords].sort((left, right) => {
    const leftService = DAEJEON_SERVICE_BY_WEEKDAY.get(left?.weekdayType)?.sortOrder ?? 99;
    const rightService = DAEJEON_SERVICE_BY_WEEKDAY.get(right?.weekdayType)?.sortOrder ?? 99;
    if (leftService !== rightService) return leftService - rightService;
    const leftTrain = Number.parseInt(String(left?.trainNumber ?? ""), 10);
    const rightTrain = Number.parseInt(String(right?.trainNumber ?? ""), 10);
    if (leftTrain !== rightTrain) return leftTrain - rightTrain;
    return (left?.sourceRowNumber ?? 0) - (right?.sourceRowNumber ?? 0);
  });

  const sourceSnapshotId = retainedEvidence.snapshotId;
  const updatedAt = retainedEvidence.observedAt;
  const seenTripIds = new Set();
  const transitTrips = [];
  const transitStopTimes = [];
  const nonRoutableGroups = [];
  const maxQuarantineCount = Math.max(1, Math.floor(sortedRecords.length * 0.05));

  for (const record of sortedRecords) {
    const trainNumber = typeof record?.trainNumber === "string" ? record.trainNumber.trim() : "";
    const trainNumberInt = Number.parseInt(trainNumber, 10);
    const serviceMeta = DAEJEON_SERVICE_BY_WEEKDAY.get(record?.weekdayType);
    if (
      record?.routeNumber !== DAEJEON_ROUTE_NUMBER
      || !serviceMeta
      || !Number.isInteger(trainNumberInt)
      || trainNumberInt <= 0
      || !SHA256.test(record?.sourceRowSha256 ?? "")
    ) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "RECORD", trainNumber);
    }

    const tripId = `trip-${DAEJEON_ROUTE_NUMBER}-${record.weekdayType}-${trainNumber}`;
    if (seenTripIds.has(tripId)) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "DUPLICATE_TRIP", tripId);
    }
    seenTripIds.add(tripId);

    const stopNames = parseDaejeonChainTokens(record.stationName, trainNumber, "stationName");
    const stopClocks = parseDaejeonChainTokens(record.departureTime, trainNumber, "departureTime");
    if (stopNames.length < 2 || stopNames.length !== stopClocks.length) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "STOP_COUNT", `${trainNumber}:${stopNames.length}:${stopClocks.length}`);
    }

    const originName = normalizeStationLabel(record.originStationName);
    const destinationName = normalizeStationLabel(record.destinationStationName);
    if (normalizeStationLabel(stopNames[0]) !== originName || normalizeStationLabel(stopNames[stopNames.length - 1]) !== destinationName) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "ENDPOINT_MISMATCH", trainNumber);
    }

    const originStation = stationByName.get(originName);
    const destinationStation = stationByName.get(destinationName);
    if (!originStation || !destinationStation) {
      failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "ENDPOINT_STATION", trainNumber);
    }

    let previousSequence = null;
    let directionStep = 0;
    let previousTimeSeconds = -1;
    let firstStopSeconds = 0;
    let nonMonotonic = false;
    const candidateStopTimes = new Array(stopNames.length);

    for (let index = 0; index < stopNames.length; index += 1) {
      const stopLabel = normalizeStationLabel(stopNames[index]);
      const station = stationByName.get(stopLabel);
      if (!station) {
        failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "UNKNOWN_STATION", `${trainNumber}:${stopNames[index]}`);
      }
      if (previousSequence !== null) {
        const delta = station.lineSequence - previousSequence;
        if (Math.abs(delta) !== 1 || (directionStep !== 0 && delta !== directionStep)) {
          throw new Error(`DAEJEON_NON_ADJACENT_STOPS: ${trainNumber}:${previousSequence}->${station.lineSequence}`);
        }
        directionStep = delta;
      }

      let clockSeconds = parseClockSeconds(stopClocks[index], trainNumber);
      if (clockSeconds < NOON_SECONDS && previousTimeSeconds >= NOON_SECONDS) {
        clockSeconds += MIDNIGHT_SECONDS;
      }
      if (clockSeconds <= previousTimeSeconds) {
        nonMonotonic = true;
        break;
      }
      if (index === 0) {
        firstStopSeconds = clockSeconds;
      }

      const stopSequence = index + 1;
      const stopRecordHash = sha256(
        JSON.stringify({
          sourceRowSha256: record.sourceRowSha256,
          stopSequence,
          stationId: station.id,
          arrivalSeconds: clockSeconds,
          departureSeconds: clockSeconds,
        }),
      );

      candidateStopTimes[index] = {
        tripId,
        stopSequence,
        stationId: station.id,
        lineId: DAEJEON_LINE_ID,
        arrivalSeconds: clockSeconds,
        departureSeconds: clockSeconds,
        pickupType: index === stopNames.length - 1 ? 1 : 0,
        dropOffType: index === 0 ? 1 : 0,
        sourceId: RETAINED_GWANGJU_PROJECTION_SOURCE_ID,
        sourceSnapshotId,
        providerRecordHash: stopRecordHash,
        evidenceHash,
        provenanceKind: "OFFICIAL_SOURCE",
        derivationKind: "OFFICIAL",
        updatedAt,
      };

      previousSequence = station.lineSequence;
      previousTimeSeconds = clockSeconds;
    }

    if (nonMonotonic) {
      nonRoutableGroups.push({
        identity: {
          trainNumber,
          routeNumber: record.routeNumber,
          routeName: record.routeName,
          originStationName: record.originStationName,
          destinationStationName: record.destinationStationName,
          serviceType: record.serviceType,
          weekdayType: record.weekdayType,
        },
        records: [record],
        reason: "TIME_NOT_MONOTONIC",
      });
      continue;
    }

    for (let index = 0; index < candidateStopTimes.length; index += 1) {
      transitStopTimes.push(candidateStopTimes[index]);
    }

    transitTrips.push({
      id: tripId,
      routeId: DAEJEON_ROUTE_ID,
      serviceId: serviceMeta.serviceId,
      tripHeadsign: destinationStation.nameKo,
      directionId: directionStep > 0 ? "down" : "up",
      trainNo: trainNumber,
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
      serviceDayStartSeconds: firstStopSeconds,
      sourceId: RETAINED_GWANGJU_PROJECTION_SOURCE_ID,
      sourceSnapshotId,
      providerRecordHash: record.sourceRowSha256,
      evidenceHash,
      provenanceKind: "OFFICIAL_SOURCE",
      derivationKind: "OFFICIAL",
      updatedAt,
    });
  }

  if (transitTrips.length === 0 || nonRoutableGroups.length > maxQuarantineCount) {
    failWithPrefix("RETAINED_DAEJEON_SCHEDULE", "QUARANTINE_LIMIT", `${nonRoutableGroups.length}/${sortedRecords.length}`);
  }

  return { transitTrips, transitStopTimes, nonRoutableGroups };
}

