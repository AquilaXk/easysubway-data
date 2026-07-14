#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cleanupPackDir, openPack } from "../route-map/pack-io.mjs";
import {
  collectTagoItxCheongchunRoster,
  validateItxServiceDates,
} from "./collect-tago-itx-cheongchun-od.mjs";
const API_ORIGIN = "https://apis.data.go.kr";
const DETAIL_URL = "https://www.data.go.kr/data/15125762/openapi.do";
const LINE_ID = "line-54a7b980b7c3";
const CAPITAL_APPROACH_LINE_ID = "line-6e39be0cb6e2";
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

export async function collectKorailItxCheongchunCompleteness({
  serviceKey,
  serviceDates,
  packPath,
  fetchImpl = fetch,
  now = new Date(),
  replay = false,
  collectRosterImpl = collectTagoItxCheongchunRoster,
  collectTimetableImpl = collectKorailItxCheongchunTimetable,
} = {}) {
  const selectedServiceDates = validateItxServiceDates(serviceDates, { now, replay });
  requiredString(packPath, "packPath");
  const canonical = readCanonicalLine(packPath);
  const canonicalStations = canonical.rosterStations;
  canonical.close();
  const serviceDays = [];
  for (const dayCd of ["8", "7", "9"]) {
    const serviceDate = selectedServiceDates[dayCd];
    let failureStage = "ROSTER";
    let roster;
    try {
      roster = await collectRosterImpl({
        serviceKey, serviceDate, kricServiceDayCode: dayCd, canonicalStations, fetchImpl, now,
      });
      if (roster.completedOdCount !== roster.expectedOdCount || roster.failedOdCount !== 0) {
        throw new Error("TAGO ITX OD matrix evidence is incomplete");
      }
      failureStage = "TIMETABLE";
      const timetable = await collectTimetableImpl({
        serviceKey,
        runDate: serviceDate,
        kricServiceDayCode: dayCd,
        packPath,
        trainNumberEvidence: roster,
        fetchImpl,
        now,
      });
      const timetableSupported = timetable.materialization?.status === "SUPPORTED";
      serviceDays.push({
        dayCd,
        serviceDate,
        status: timetableSupported ? "SUPPORTED" : "MISSING",
        ...(!timetableSupported ? {
          failureStage: "TIMETABLE",
          failureReasonCode: timetable.materialization?.status === "MISSING_STATION_TIMES"
            ? timetable.materialization?.stationTimeCapability?.reasonCode ?? "PLANNED_TIME_MISSING"
            : "TIMETABLE_MATERIALIZATION_INCOMPLETE",
        } : {}),
        expectedOdCount: roster.expectedOdCount,
        completedOdCount: roster.completedOdCount,
        failedOdCount: roster.failedOdCount,
        stationSetHash: roster.stationSetHash,
        odMatrixHash: roster.odMatrixHash,
        roster,
        timetable,
      });
    } catch (error) {
      const failureContext = completenessFailureContext(error);
      serviceDays.push({
        dayCd,
        serviceDate,
        status: "MISSING",
        failureStage,
        failureReasonCode: completenessFailureReason(error),
        legacyDaejeonRowCount: Number.isInteger(error?.legacyDaejeonRowCount) ? error.legacyDaejeonRowCount : 0,
        legacyYongsanDaejeonTripCount: Number.isInteger(error?.legacyYongsanDaejeonTripCount)
          ? error.legacyYongsanDaejeonTripCount : 0,
        ...(roster ? {
          expectedOdCount: roster.expectedOdCount,
          completedOdCount: roster.completedOdCount,
          failedOdCount: roster.failedOdCount,
          stationSetHash: roster.stationSetHash,
          odMatrixHash: roster.odMatrixHash,
          roster,
        } : {}),
        ...(failureContext ? { failureContext } : {}),
      });
    }
  }
  const complete = serviceDays.length === 3 && serviceDays.every(({ status }) => status === "SUPPORTED");
  const admissionStatus = complete ? (replay ? "REPLAY_ONLY" : "SUPPORTED") : "MISSING";
  const artifact = {
    schemaVersion: 1,
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    serviceId: "ITX_CHEONGCHUN",
    observedAt: now.toISOString(),
    timezone: "Asia/Seoul",
    validationMode: replay ? "REPLAY" : "ADMISSION",
    selectedServiceDates,
    admissionStatus,
    admissionEligible: admissionStatus === "SUPPORTED",
    allowedConsumerIssues: ["#1400", "#2098", "#2099"],
    legacyDaejeonRowCount: serviceDays.reduce((total, day) => (
      total + (day.timetable?.legacyDaejeonRowCount ?? day.legacyDaejeonRowCount ?? 0)
    ), 0),
    legacyYongsanDaejeonTripCount: serviceDays.reduce((total, day) => (
      total + (day.timetable?.legacyYongsanDaejeonTripCount ?? day.legacyYongsanDaejeonTripCount ?? 0)
    ), 0),
    serviceDays,
    materialization: { status: complete ? "SUPPORTED" : "MISSING" },
    credentialRedacted: true,
  };
  artifact.evidenceHash = sha256(JSON.stringify(artifact));
  return artifact;
}

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
  const { legacyDaejeonRowCount, legacyYongsanDaejeonTripCount } = legacyDaejeonCounts(
    plans.rows,
    info.rows,
    trainNumberEvidence.trainNumbers,
  );
  if (legacyDaejeonRowCount !== 0 || legacyYongsanDaejeonTripCount !== 0) {
    const error = new Error("Korail ITX legacy Daejeon data must be zero");
    error.legacyDaejeonRowCount = legacyDaejeonRowCount;
    error.legacyYongsanDaejeonTripCount = legacyYongsanDaejeonTripCount;
    throw error;
  }
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
  const directions = [...new Set(analyzed.stationSequences.map(({ directionCode }) => directionCode))].sort();
  if (!directions.includes("U") || !directions.includes("D")) {
    throw new Error("Korail ITX roster must include both directions");
  }
  const terminalVariants = [...new Map(analyzed.stationSequences.map((trip) => {
    const variant = {
      directionCode: trip.directionCode,
      originStationName: trip.originStationName,
      destinationStationName: trip.destinationStationName,
    };
    return [JSON.stringify(variant), variant];
  })).values()].sort((left, right) => (
    left.directionCode.localeCompare(right.directionCode)
    || naturalCompare(left.originStationName, right.originStationName)
    || naturalCompare(left.destinationStationName, right.destinationStationName)
  ));
  const materialized = analyzed.missingTimestampStopCount === 0
    ? materializeAnalyzedKorailItxRows(analyzed, kricServiceDayCode, runDate)
    : { transitTrips: [], transitStopTimes: [], trainNumbers: [], stationMappings: analyzed.stationMappings };
  if (analyzed.missingTimestampStopCount === 0) {
    validateTagoOdJoin(materialized, trainNumberEvidence, kricServiceDayCode, runDate);
  }
  const checkedStopCount = analyzed.stationSequences.reduce((total, trip) => total + trip.stops.length, 0);
  const populatedTimestampStopCount = checkedStopCount - analyzed.missingTimestampStopCount;
  let stationTimeCapabilityStatus = "SUPPORTED";
  let stationTimeCapabilityReasonCode = "OFFICIAL_OPERATION_FIELDS_POPULATED";
  if (analyzed.missingTimestampStopCount > 0) {
    stationTimeCapabilityStatus = analyzed.populatedTimestampFieldCount === 0
      ? "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE" : "MISSING";
    stationTimeCapabilityReasonCode = analyzed.populatedTimestampFieldCount === 0
      ? "OFFICIAL_OPERATION_FIELDS_EMPTY" : "PARTIAL_OFFICIAL_OPERATION_FIELDS_EMPTY";
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
    stationSequenceRowCount: checkedStopCount,
    stopTimeCount: materialized.transitStopTimes.length,
    trainNumbers: analyzed.trainNumbers,
    stationMappings: analyzed.stationMappings,
    stationSequences: analyzed.stationSequences,
    directions,
    terminalVariants,
    legacyDaejeonRowCount,
    legacyYongsanDaejeonTripCount,
    trainNumberSets: {
      roster: [...new Set(trainNumberEvidence.trainNumbers.map(normalizeTrainNumber))].sort(naturalCompare),
      plan: analyzed.trainNumbers,
      info: analyzed.trainNumbers,
      materialized: materialized.trainNumbers,
    },
    materialization: {
      status: analyzed.missingTimestampStopCount === 0 ? "SUPPORTED" : "MISSING_STATION_TIMES",
      missingTimestampStopCount: analyzed.missingTimestampStopCount,
      stationTimeCapability: {
        status: stationTimeCapabilityStatus,
        reasonCode: stationTimeCapabilityReasonCode,
        checkedStopCount,
        populatedTimestampStopCount,
        requiredTimestampFieldCount: analyzed.requiredTimestampFieldCount,
        populatedTimestampFieldCount: analyzed.populatedTimestampFieldCount,
      },
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
  if (analyzed.missingTimestampStopCount > 0) throw new Error("Korail ITX planned timestamp missing");
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
    const sequenceAnalysis = analyzeStationSequences({ grouped, canonical, passengerStopCodes, planByTrain, runDate });
    return {
      trainNumbers: [...grouped.keys()].sort(naturalCompare),
      stationMappings: [...sequenceAnalysis.stationMappings.values()].sort((left, right) => (
        left.lineSequence - right.lineSequence || naturalCompare(left.providerStationCode, right.providerStationCode)
      )),
      stationSequences: sequenceAnalysis.stationSequences,
      missingTimestampStopCount: sequenceAnalysis.missingTimestampStopCount,
      requiredTimestampFieldCount: sequenceAnalysis.requiredTimestampFieldCount,
      populatedTimestampFieldCount: sequenceAnalysis.populatedTimestampFieldCount,
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

function analyzeStationSequences({ grouped, canonical, passengerStopCodes, planByTrain, runDate }) {
  const stationMappings = new Map();
  const stationSequences = [];
  let missingTimestampStopCount = 0;
  let requiredTimestampFieldCount = 0;
  let populatedTimestampFieldCount = 0;
  for (const [trainNumber, trainRows] of [...grouped.entries()].sort(([left], [right]) => naturalCompare(left, right))) {
    const ordered = orderedTrainRows(trainRows, trainNumber);
    const directionCodes = new Set(ordered.map(({ row }) => korailDirectionCode(row.uppln_dn_se_cd, trainNumber)));
    if (directionCodes.size !== 1) throw new Error(`Korail ITX direction mismatch: ${safeToken(trainNumber)}`);
    const selected = selectPassengerStops({ ordered, canonical, passengerStopCodes, stationMappings, trainNumber });
    const stops = assignCanonicalLineIds(selected.stops, trainNumber);
    const plan = planByTrain.get(trainNumber);
    validateCanonicalTrip(stops, ordered, trainNumber, plan, runDate);
    missingTimestampStopCount += selected.missingTimestampStopCount;
    requiredTimestampFieldCount += selected.requiredTimestampFieldCount;
    populatedTimestampFieldCount += selected.populatedTimestampFieldCount;
    stationSequences.push({
      trainNumber,
      directionCode: [...directionCodes][0],
      originStationName: plan.dptre_stn_nm,
      destinationStationName: plan.arvl_stn_nm,
      stops,
    });
  }
  return {
    stationMappings,
    stationSequences,
    missingTimestampStopCount,
    requiredTimestampFieldCount,
    populatedTimestampFieldCount,
  };
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
  let requiredTimestampFieldCount = 0;
  let populatedTimestampFieldCount = 0;
  const passengerRows = ordered.flatMap(({ row, sequence }, index) => {
    const stopCode = String(row.stop_se_cd);
    const expectedStopName = passengerStopCodes.get(stopCode);
    if (!expectedStopName) return [];
    if (normalize(expectedStopName) !== normalize(row.stop_se_nm)) {
      throw new Error(`Korail ITX passenger stop name mismatch: ${safeToken(trainNumber)}/${safeLabel(row.stn_nm)}`);
    }
    const matches = canonical.byName.get(normalizeStationName(row.stn_nm)) ?? [];
    const station = matches.length === 1 ? matches[0] : null;
    return [{ row, sequence, index, station, stopCode }];
  });
  for (const [index, { row, sequence, station, stopCode }] of passengerRows.entries()) {
    if (!station) throw new Error(`Korail ITX passenger stop canonical mapping missing: ${safeToken(trainNumber)}/${safeLabel(row.stn_nm)}`);
    const arrivalTimestamp = validProviderTimestamp(row.trn_arvl_dt);
    const departureTimestamp = validProviderTimestamp(row.trn_dptre_dt);
    if (index > 0) {
      requiredTimestampFieldCount += 1;
      if (arrivalTimestamp !== null) populatedTimestampFieldCount += 1;
    }
    if (index < passengerRows.length - 1) {
      requiredTimestampFieldCount += 1;
      if (departureTimestamp !== null) populatedTimestampFieldCount += 1;
    }
    if ((index > 0 && arrivalTimestamp === null)
      || (index < passengerRows.length - 1 && departureTimestamp === null)) missingTimestampStopCount += 1;
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
      lineMemberships: station.lineMemberships,
      stopCode,
      stopName: String(row.stop_se_nm),
      arrivalTimestamp,
      departureTimestamp,
    });
  }
  return { stops, missingTimestampStopCount, requiredTimestampFieldCount, populatedTimestampFieldCount };
}

function assignCanonicalLineIds(stops, trainNumber) {
  const resolved = stops.map((stop) => ({
    ...stop,
    canonicalLineId: Number.isInteger(stop.lineSequence) ? LINE_ID : null,
  }));
  const lineIndexes = resolved.flatMap((stop, index) => Number.isInteger(stop.lineSequence) ? [index] : []);
  const firstLineIndex = lineIndexes[0];
  const lastLineIndex = lineIndexes.at(-1);
  if (firstLineIndex === undefined || lastLineIndex === undefined) {
    throw new Error(`Korail ITX canonical line segment missing: ${safeToken(trainNumber)}`);
  }
  resolveOutsideSegmentLine(resolved, 0, firstLineIndex, trainNumber);
  resolveOutsideSegmentLine(resolved, lastLineIndex, resolved.length - 1, trainNumber);
  if (resolved.some(({ canonicalLineId }) => canonicalLineId === null)) {
    throw new Error(`Korail ITX outside-line segment mapping is incomplete: ${safeToken(trainNumber)}`);
  }
  return resolved;
}

function resolveOutsideSegmentLine(stops, start, end, trainNumber) {
  if (start === end || stops.slice(start, end + 1).every(({ canonicalLineId }) => canonicalLineId === LINE_ID)) return;
  const common = stops.slice(start, end + 1).reduce((shared, stop) => {
    const memberships = new Set(stop.lineMemberships.map(({ lineId }) => lineId));
    return shared === null ? memberships : new Set([...shared].filter((lineId) => memberships.has(lineId)));
  }, null);
  const candidates = [...(common ?? [])].filter((lineId) => lineId !== LINE_ID).sort();
  const selectedLineId = candidates.includes(CAPITAL_APPROACH_LINE_ID)
    ? CAPITAL_APPROACH_LINE_ID
    : candidates.length === 1 ? candidates[0] : null;
  if (selectedLineId === null) {
    throw new Error(`Korail ITX outside-line segment mapping is missing or ambiguous: ${safeToken(trainNumber)}`);
  }
  for (let index = start; index <= end; index += 1) {
    if (stops[index].canonicalLineId === null) stops[index].canonicalLineId = selectedLineId;
  }
}

function validateCanonicalTrip(stops, ordered, trainNumber, plan, runDate) {
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
  const lineStops = stops.filter(({ lineSequence }) => Number.isInteger(lineSequence));
  if (lineStops.length < 2) throw new Error(`Korail ITX trip must have at least 2 canonical line stops: ${safeToken(trainNumber)}`);
  if (validProviderTimestamp(plan.trn_plan_dptre_dt) === null || validProviderTimestamp(plan.trn_plan_arvl_dt) === null) {
    throw new Error(`Korail ITX plan timestamp missing: ${safeToken(trainNumber)}`);
  }
  const planDepartureSeconds = timestampSeconds(plan.trn_plan_dptre_dt, runDate, `plan departure[${safeToken(trainNumber)}]`);
  const planArrivalSeconds = timestampSeconds(plan.trn_plan_arvl_dt, runDate, `plan arrival[${safeToken(trainNumber)}]`);
  if (planDepartureSeconds > planArrivalSeconds) throw new Error(`Korail ITX plan arrival must follow departure: ${safeToken(trainNumber)}`);
  if (stops[0].departureTimestamp !== null
    && timestampSeconds(stops[0].departureTimestamp, runDate, `first stop departure[${safeToken(trainNumber)}]`)
      !== planDepartureSeconds) {
    throw new Error(`Korail ITX plan departure does not match first stop departure: ${safeToken(trainNumber)}`);
  }
  if (stops.at(-1).arrivalTimestamp !== null
    && timestampSeconds(stops.at(-1).arrivalTimestamp, runDate, `last stop arrival[${safeToken(trainNumber)}]`)
      !== planArrivalSeconds) {
    throw new Error(`Korail ITX plan arrival does not match last stop arrival: ${safeToken(trainNumber)}`);
  }
  if (normalizeStationName(stops[0].providerStationName) !== normalizeStationName(plan.dptre_stn_nm)
    || normalizeStationName(stops.at(-1).providerStationName) !== normalizeStationName(plan.arvl_stn_nm)) {
    throw new Error(`Korail ITX plan endpoint mismatch: ${safeToken(trainNumber)}`);
  }
  validateLineSequenceOnly(lineStops, trainNumber);
}

function materializeAnalyzedKorailItxRows(analyzed, kricServiceDayCode, runDate) {
  const transitTrips = [];
  const transitStopTimes = [];
  const serviceId = { "8": "weekday-kric", "7": "saturday-kric", "9": "holiday-kric" }[kricServiceDayCode];
  if (serviceId === undefined) throw new Error("kricServiceDayCode must be 7, 8, or 9");
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
        lineId: stop.canonicalLineId,
        trnNo: trip.trainNumber,
        dayCd: kricServiceDayCode,
        arrivalSeconds,
        departureSeconds,
        servicePattern: "EXPRESS",
        lineSequence: stop.lineSequence,
      };
    });
    validateProviderOrder(rows, trip.trainNumber);
    const lineRows = rows.filter(({ lineSequence }) => Number.isInteger(lineSequence));
    const directionId = lineRows.at(-1).lineSequence > lineRows[0].lineSequence ? "up" : "down";
    const routeId = `route-${LINE_ID}-${directionId}`;
    const tripId = `${routeId}-${trip.trainNumber}-${kricServiceDayCode}`;
    transitTrips.push({
      id: tripId,
      routeId,
      serviceId,
      tripHeadsign: trip.stops.at(-1).providerStationName,
      directionId,
      servicePattern: "EXPRESS",
    });
    rows.forEach((row, index) => transitStopTimes.push({
      tripId,
      stopSequence: index + 1,
      stationId: row.stationId,
      lineId: row.lineId,
      arrivalSeconds: row.arrivalSeconds,
      departureSeconds: row.departureSeconds,
    }));
  }
  return {
    transitTrips,
    transitStopTimes,
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
  if (evidence?.artifactKind !== "tago-itx-cheongchun-roster-evidence" || evidence?.serviceId !== "ITX_CHEONGCHUN") {
    throw new Error("TAGO ITX train number evidence is invalid");
  }
  if (evidence.kricServiceDayCode !== kricServiceDayCode) throw new Error("TAGO/Korail service day code mismatch");
  if (!Number.isInteger(evidence.expectedOdCount) || evidence.expectedOdCount <= 0
    || evidence.completedOdCount !== evidence.expectedOdCount || evidence.failedOdCount !== 0) {
    throw new Error("TAGO ITX OD matrix evidence is incomplete");
  }
  if (![evidence.stationSetHash, evidence.odMatrixHash, evidence.evidenceHash]
    .every((value) => /^[a-f0-9]{64}$/.test(value ?? ""))) {
    throw new Error("TAGO ITX roster hash is invalid");
  }
  if (!Array.isArray(evidence.trainNumbers) || !Array.isArray(evidence.itineraries)
    || evidence.trainNumbers.length === 0 || evidence.itineraries.length === 0) {
    throw new Error("TAGO ITX train number evidence is incomplete");
  }
  const roster = new Set(evidence.trainNumbers.map(normalizeTrainNumber));
  const itineraryTrains = new Set(evidence.itineraries.map(({ trainNumber }) => normalizeTrainNumber(trainNumber)));
  if (roster.size !== evidence.trainNumbers.length || !sameSet(roster, itineraryTrains)) {
    throw new Error("TAGO ITX roster/itinerary train number set mismatch");
  }
}

function validateTagoOdJoin(materialized, evidence, dayCd, runDate) {
  if (evidence.serviceDate !== runDate) throw new Error("Korail/TAGO ITX service date mismatch");
  const tripsByNumber = new Map(materialized.trainNumbers.map((trainNumber) => [
    trainNumber,
    materialized.transitTrips.find(({ id }) => id.endsWith(`-${trainNumber}-${dayCd}`)),
  ]));
  for (const [index, itinerary] of evidence.itineraries.entries()) {
    const trainNumber = normalizeTrainNumber(itinerary.trainNumber);
    const departureStationId = requiredString(itinerary.departureStationId, `itineraries[${index}].departureStationId`);
    const arrivalStationId = requiredString(itinerary.arrivalStationId, `itineraries[${index}].arrivalStationId`);
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

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function legacyDaejeonCounts(plans, infoRows, trainNumbers) {
  const allowed = new Set(trainNumbers.map(normalizeTrainNumber));
  const isAllowed = (row) => allowed.has(normalizeTrainNumber(row.trn_no));
  const legacyDaejeonRowCount = infoRows.filter((row) => (
    isAllowed(row) && normalizeStationName(row.stn_nm) === normalizeStationName("대전")
  )).length;
  const legacyYongsanDaejeonTripCount = plans.filter((row) => {
    if (!isAllowed(row)) return false;
    const endpoints = [row.dptre_stn_nm, row.arvl_stn_nm].map(normalizeStationName);
    return endpoints.includes(normalizeStationName("용산")) && endpoints.includes(normalizeStationName("대전"));
  }).length;
  return { legacyDaejeonRowCount, legacyYongsanDaejeonTripCount };
}

function completenessFailureReason(error) {
  const message = error instanceof Error ? error.message : "";
  if (/HTTP \d+/.test(message)) return "PROVIDER_HTTP_FAILURE";
  if (/transport failure/.test(message)) return "PROVIDER_TRANSPORT_FAILURE";
  if (/pagination incomplete/.test(message)) return "PROVIDER_PAGINATION_INCOMPLETE";
  if (/schema mismatch/.test(message)) return "PROVIDER_SCHEMA_FAILURE";
  if (/provider resultCode/.test(message)) return "PROVIDER_RESULT_FAILURE";
  if (/train grade is missing or ambiguous/.test(message)) return "TRAIN_GRADE_MAPPING_INCOMPLETE";
  if (/station mapping/.test(message)) return "STATION_MAPPING_INCOMPLETE";
  if (/canonical mapping missing/.test(message)) return "CANONICAL_STATION_MAPPING_INCOMPLETE";
  if (/roster stations must be unique/.test(message)) return "ROSTER_STATION_SET_INVALID";
  if (/roster returned zero rows/.test(message)) return "ROSTER_EMPTY";
  if (/run plan returned zero rows/.test(message)) return "OFFICIAL_RUN_PLAN_EMPTY";
  if (/run info returned zero rows/.test(message)) return "OFFICIAL_RUN_INFO_EMPTY";
  if (/legacy Daejeon data must be zero/.test(message)) return "LEGACY_DAEJEON_DATA_PRESENT";
  if (/OD matrix/.test(message)) return "OD_MATRIX_INCOMPLETE";
  if (/both directions/.test(message)) return "PARTIAL_DIRECTION";
  if (/timestamp missing/.test(message)) return "PLANNED_TIME_MISSING";
  return "PROVIDER_OR_SCHEMA_FAILURE";
}

function completenessFailureContext(error) {
  const message = error instanceof Error ? error.message : "";
  const station = /station mapping is missing or ambiguous: (.+)$/.exec(message)?.[1];
  if (station) return safeLabel(station);
  const pagination = /pagination incomplete: (operation=[A-Za-z0-9]+,collected=\d+,total=(?:\d+|UNKNOWN),pages=\d+)$/.exec(message)?.[1];
  if (pagination) return pagination;
  if (/run plan returned zero rows/.test(message)) return "operation=travelerTrainRunPlan2,total=0";
  if (/run info returned zero rows/.test(message)) return "operation=travelerTrainRunInfo2,total=0";
  return null;
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
    const lineRows = opened.db.prepare(`
      SELECT stations.id, stations.name_ko, station_lines.line_sequence
      FROM station_lines
      JOIN stations ON stations.id = station_lines.station_id
      WHERE station_lines.line_id = ?
      ORDER BY station_lines.line_sequence, stations.id
    `).all(LINE_ID);
    if (lineRows.length === 0) throw new Error(`canonical pack has no line: ${LINE_ID}`);
    const lineSequenceByStation = new Map(lineRows.map((row) => [row.id, row.line_sequence]));
    const rows = opened.db.prepare(`
      SELECT stations.id, stations.name_ko, station_lines.line_id, station_lines.line_sequence
      FROM stations
      JOIN station_lines ON station_lines.station_id = stations.id
      WHERE stations.region = '수도권'
      ORDER BY stations.id, station_lines.line_id
    `).all();
    const stationsById = new Map();
    for (const row of rows) {
      const station = stationsById.get(row.id) ?? { stationId: row.id, nameKo: row.name_ko, lineMemberships: [] };
      station.lineMemberships.push({ lineId: row.line_id, lineSequence: row.line_sequence });
      stationsById.set(row.id, station);
    }
    const byName = new Map();
    for (const station of stationsById.values()) {
      const name = normalizeStationName(station.nameKo);
      const matches = byName.get(name) ?? [];
      matches.push({
        stationId: station.stationId,
        lineSequence: lineSequenceByStation.get(station.stationId) ?? null,
        lineMemberships: station.lineMemberships,
      });
      byName.set(name, matches);
    }
    return {
      byName,
      rosterStations: lineRows.map((row) => ({ canonicalStationId: row.id, nameKo: row.name_ko })),
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
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1].departureSeconds > rows[index].arrivalSeconds) {
      throw new Error(`Korail ITX stop time is not monotonic: ${safeToken(trainNumber)}`);
    }
  }
  validateLineSequenceOnly(rows.filter(({ lineSequence }) => Number.isInteger(lineSequence)), trainNumber);
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
  const operation = new URL(endpoint).pathname.split("/").at(-1);
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
    if (page.rows.length === 0) {
      throw new Error(
        `Korail train operation API pagination incomplete: operation=${safeToken(operation)},` +
        `collected=${rows.length},total=${totalCount ?? "UNKNOWN"},pages=${hashes.length}`,
      );
    }
  }
  if (rows.length !== totalCount) {
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

function korailDirectionCode(value, trainNumber) {
  if (value !== "U" && value !== "D") {
    throw new Error(`Korail ITX direction code must be U or D: ${safeToken(trainNumber)}`);
  }
  return value;
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
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]?.replace(/^--/, "");
    if (!key) continue;
    if (argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined) result[key] = true;
    else result[key] = argv[index += 1];
  }
  return result;
}

export async function runKorailItxCompletenessCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  collectImpl = collectKorailItxCheongchunCompleteness,
} = {}) {
  const args = parseArgs(argv);
  const output = requiredString(args.output, "--output");
  if (!path.isAbsolute(output)) throw new Error("--output must be absolute");
  const packPath = requiredString(args["canonical-pack"], "--canonical-pack");
  const serviceKey = requiredString(env.DATA_GO_KR_SERVICE_KEY, "DATA_GO_KR_SERVICE_KEY");
  const replay = args.replay === true;
  const serviceDates = {
    "8": args["day8-date"],
    "7": args["day7-date"],
    "9": args["day9-date"],
  };
  validateItxServiceDates(serviceDates, { now, replay });
  let artifact;
  try {
    artifact = await collectImpl({ serviceKey, serviceDates, packPath, now, replay });
  } catch (error) {
    artifact = {
      schemaVersion: 1,
      artifactKind: "korail-itx-cheongchun-completeness-evidence",
      serviceId: "ITX_CHEONGCHUN",
      observedAt: now.toISOString(),
      timezone: "Asia/Seoul",
      validationMode: replay ? "REPLAY" : "ADMISSION",
      selectedServiceDates: serviceDates,
      admissionStatus: "MISSING",
      admissionEligible: false,
      failureReasonCode: completenessFailureReason(error),
      allowedConsumerIssues: ["#1400", "#2098", "#2099"],
      legacyDaejeonRowCount: 0,
      legacyYongsanDaejeonTripCount: 0,
      serviceDays: [],
      materialization: { status: "MISSING" },
      credentialRedacted: true,
    };
    artifact.evidenceHash = sha256(JSON.stringify(artifact));
  }
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  return { artifact, exitCode: artifact.admissionStatus === "SUPPORTED" ? 0 : 1 };
}

async function main() {
  const { artifact, exitCode } = await runKorailItxCompletenessCli();
  const totalExpectedOdCount = artifact.serviceDays.reduce((total, day) => total + (day.expectedOdCount ?? 0), 0);
  const totalCompletedOdCount = artifact.serviceDays.reduce((total, day) => total + (day.completedOdCount ?? 0), 0);
  const totalFailedOdCount = artifact.serviceDays.reduce((total, day) => total + (day.failedOdCount ?? 0), 0);
  const failureCodes = artifact.serviceDays
    .filter(({ status }) => status !== "SUPPORTED")
    .map(({ dayCd, failureStage, failureReasonCode }) => `${dayCd}:${failureStage}:${failureReasonCode}`)
    .join(",");
  console.log(
    `sanitized Korail ITX-청춘 completeness evidence ready: status=${artifact.admissionStatus},` +
    ` serviceDays=${artifact.serviceDays.length}, expectedOd=${totalExpectedOdCount},` +
    ` completedOd=${totalCompletedOdCount}, failedOd=${totalFailedOdCount},` +
    ` failures=${failureCodes}, observedAt=${artifact.observedAt}, evidenceHash=${artifact.evidenceHash}`,
  );
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Korail ITX-청춘 collector failed");
    process.exitCode = 1;
  });
}
