#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_EVIDENCE_BYTES = 4_194_304;
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion", "artifactKind", "serviceId", "observedAt", "timezone", "validationMode",
  "selectedServiceDates", "validationStatus", "admissionStatus", "admissionEligible",
  "failureStage", "failureReasonCode", "allowedConsumerIssues", "legacyDaejeonRowCount",
  "legacyYongsanDaejeonTripCount", "serviceDays", "snapshotDiff", "sourceTimetableArtifact",
  "materialization", "stationCatalogPackIdentity", "credentialRedacted", "evidenceHash",
]);
const PRE_SERVICE_DAY_TOP_LEVEL_KEYS = new Set([
  "schemaVersion", "artifactKind", "serviceId", "observedAt", "timezone", "validationMode",
  "selectedServiceDates", "validationStatus", "admissionStatus", "admissionEligible",
  "failureReasonCode", "allowedConsumerIssues", "legacyDaejeonRowCount",
  "legacyYongsanDaejeonTripCount", "serviceDays", "materialization", "credentialRedacted",
  "evidenceHash",
]);
const SERVICE_DAY_KEYS = new Set([
  "dayCd", "serviceDate", "status", "failureStage", "failureReasonCode", "failureContext",
  "expectedOdCount", "completedOdCount", "failedOdCount", "stationSetHash", "odMatrixHash",
  "trainSetHashes", "korailPlanSummary", "warnings", "reconstructionSummary", "roster",
  "timetable", "legacyDaejeonRowCount", "legacyYongsanDaejeonTripCount",
]);
const DAY_CODES = ["8", "7", "9"];
const FAILURE_STAGES = new Set(["ROSTER", "OD_MATERIALIZATION", "PLAN_CORROBORATION", "SNAPSHOT_DIFF"]);
const FAILURE_REASONS = new Set([
  "TAGO_QUOTA_BUDGET_EXHAUSTED", "TAGO_OD_DUPLICATE", "TAGO_OD_PAIR_COVERAGE_INCOMPLETE",
  "TAGO_OD_TIME_CONFLICT", "TAGO_OD_STOP_SEQUENCE_INVALID", "KORAIL_PLAN_DUPLICATE",
  "KORAIL_PLAN_MISMATCH", "PROVIDER_HTTP_FAILURE", "PROVIDER_TRANSPORT_FAILURE",
  "PROVIDER_PAGINATION_INCOMPLETE", "PROVIDER_SCHEMA_FAILURE", "PROVIDER_RESULT_FAILURE",
  "TRAIN_GRADE_MAPPING_INCOMPLETE", "STATION_MAPPING_INCOMPLETE",
  "CANONICAL_STATION_MAPPING_INCOMPLETE", "ROSTER_STATION_SET_INVALID", "ROSTER_EMPTY",
  "OFFICIAL_RUN_PLAN_EMPTY", "OFFICIAL_RUN_INFO_EMPTY", "LEGACY_DAEJEON_DATA_PRESENT",
  "OD_MATRIX_INCOMPLETE", "PARTIAL_DIRECTION", "PLANNED_TIME_MISSING",
  "TIMETABLE_MATERIALIZATION_INCOMPLETE", "PROVIDER_OR_SCHEMA_FAILURE", "SNAPSHOT_ANOMALY_BLOCKED",
]);
const VALIDATION_STATUSES = new Set(["SUPPORTED", "MISSING"]);
const ADMISSION_STATUSES = new Set([
  "SUPPORTED", "MISSING", "REPLAY_ONLY", "BOOTSTRAP_REVIEW_REQUIRED", "CHANGE_REVIEW_REQUIRED",
]);
const KORAIL_PLAN_MISMATCH_RELATIONS = new Set([
  "run_date", "endpoint", "tago_endpoint_missing", "forbidden_daejeon_endpoint",
  "both_endpoints", "departure_endpoint", "arrival_endpoint",
  "reversed", "departure_only", "arrival_only", "neither",
  "timestamp_format", "departure_time", "arrival_time",
]);
const TAGO_DATE_MISMATCH_RELATIONS = new Set([
  "previous_calendar_day", "next_calendar_day", "non_adjacent_calendar_day",
]);
const TAGO_QUERY_CALENDAR_OFFSETS = new Set(["queryCalendarOffset=0", "queryCalendarOffset=1"]);

class DiagnosticError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function invalid(code) {
  throw new DiagnosticError(code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactAllowedKeys(value, keys, code) {
  if (!object(value) || Object.keys(value).some((key) => !keys.has(key))) invalid(code);
}

function exactKeys(value, keys, code) {
  if (!object(value) || Object.keys(value).length !== keys.size
    || [...keys].some((key) => !Object.hasOwn(value, key))) invalid(code);
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function serviceDates(value) {
  if (!object(value) || Object.keys(value).length !== DAY_CODES.length
    || DAY_CODES.some((dayCd) => typeof value[dayCd] !== "string" || !/^\d{8}$/.test(value[dayCd]))) invalid("BASE_IDENTITY");
  return { "7": value["7"], "8": value["8"], "9": value["9"] };
}

function korailPlanMismatchContext(value) {
  const [reason, trainNumber, relation, extra] = value.split(",");
  return extra === undefined
    && reason === "reason=KORAIL_PLAN_MISMATCH"
    && /^trainNumber=\d+$/.test(trainNumber)
    && typeof relation === "string"
    && relation.startsWith("relation=")
    && KORAIL_PLAN_MISMATCH_RELATIONS.has(relation.slice("relation=".length));
}

function tagoDateMismatchContext(value) {
  const [operation, reason, relation, queryCalendarOffset, extra] = value.split(",");
  return extra === undefined
    && operation === "operation=GetStrtpntAlocFndTrainInfo"
    && reason === "reason=date_mismatch"
    && typeof relation === "string"
    && relation.startsWith("relation=")
    && TAGO_DATE_MISMATCH_RELATIONS.has(relation.slice("relation=".length))
    && TAGO_QUERY_CALENDAR_OFFSETS.has(queryCalendarOffset);
}

function failureContextInventory(value) {
  if (value == null) return [];
  if (typeof value !== "string") invalid("FAILURE_CONTEXT");
  if (value === "operation=travelerTrainRunPlan2,total=0") return ["KORAIL_RUN_PLAN_EMPTY"];
  if (value === "operation=travelerTrainRunInfo2,total=0") return ["KORAIL_RUN_INFO_EMPTY"];
  if (/^reason=KORAIL_PLAN_(?:MISSING|DUPLICATE),trainNumber=\d+$/.test(value)) return ["KORAIL_PLAN"];
  if (korailPlanMismatchContext(value)) return ["KORAIL_PLAN"];
  if (/^operation=[A-Za-z0-9]+,reason=schema_mismatch,(?:invalid-json|content-type|body|item|totalCount)(?:,bodyFields=[A-Za-z0-9_,.-]+)?$/.test(value)) return ["TAGO_SCHEMA"];
  if (/^operation=[A-Za-z0-9]+,collected=\d+,total=(?:\d+|UNKNOWN),pages=\d+$/.test(value)) return ["TAGO_PAGINATION"];
  if (/^missingStations=[\p{L}\p{N},._-]+$/u.test(value)) return ["TAGO_REQUIRED_STATION_MAPPING"];
  if (/^[\p{L}\p{N} ._-]+$/u.test(value)) return ["STATION_MAPPING"];
  const suffix = ",departureStationId=";
  const suffixIndex = value.indexOf(suffix);
  if (suffixIndex > 0) {
    const prefix = value.slice(0, suffixIndex);
    const stationTuple = value.slice(suffixIndex);
    if (!/^,departureStationId=[A-Za-z0-9._\/+:-]{1,64},arrivalStationId=[A-Za-z0-9._\/+:-]{1,64}$/.test(stationTuple)) invalid("FAILURE_CONTEXT");
    if (prefix === "operation=GetStrtpntAlocFndTrainInfo") return ["TAGO_OD_PROVIDER_FAILURE"];
    if (/^operation=GetStrtpntAlocFndTrainInfo,httpStatus=\d{3}$/.test(prefix)) return ["TAGO_OD_HTTP_FAILURE"];
    if (tagoDateMismatchContext(prefix)) return ["TAGO_OD_DATE_MISMATCH"];
    if (/^operation=GetStrtpntAlocFndTrainInfo,reason=schema_mismatch,(?:invalid-json|content-type|body|item|totalCount)(?:,bodyFields=[A-Za-z0-9_,.-]+)?$/.test(prefix)) return ["TAGO_OD_SCHEMA_FAILURE"];
    if (prefix === "operation=GetStrtpntAlocFndTrainInfo,reason=pagination_incomplete") return ["TAGO_OD_PAGINATION_INCOMPLETE"];
    if (/^operation=GetStrtpntAlocFndTrainInfo,reason=(?:station_mismatch|date_mismatch|train_grade_mismatch|time_order_mismatch|field_contract_mismatch)$/.test(prefix)) return ["TAGO_OD_FIELD_CONTRACT_FAILURE"];
    invalid("FAILURE_CONTEXT");
  }
  invalid("FAILURE_CONTEXT");
}

function validateFailure(stage, reason, code) {
  if (!FAILURE_STAGES.has(stage) || !FAILURE_REASONS.has(reason)) invalid(code);
}

function addSafe(left, right) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) invalid("SERVICE_DAY_SHAPE");
  return total;
}

function validateEvidence(value) {
  exactAllowedKeys(value, TOP_LEVEL_KEYS, "TOP_LEVEL_SHAPE");
  if (value.schemaVersion !== 2 || value.artifactKind !== "korail-itx-cheongchun-completeness-evidence"
    || value.serviceId !== "ITX_CHEONGCHUN" || value.timezone !== "Asia/Seoul"
    || !/^\d{4}-\d{2}-\d{2}T/.test(value.observedAt ?? "")
    || !["ADMISSION", "REPLAY"].includes(value.validationMode)
    || !VALIDATION_STATUSES.has(value.validationStatus) || !ADMISSION_STATUSES.has(value.admissionStatus)
    || typeof value.admissionEligible !== "boolean" || value.credentialRedacted !== true
    || !Array.isArray(value.allowedConsumerIssues) || !nonnegativeInteger(value.legacyDaejeonRowCount)
    || !nonnegativeInteger(value.legacyYongsanDaejeonTripCount) || !object(value.materialization)
    || !/^[a-f0-9]{64}$/.test(value.evidenceHash ?? "")) invalid("BASE_IDENTITY");
  const selectedServiceDates = serviceDates(value.selectedServiceDates);
  const { evidenceHash, ...withoutEvidenceHash } = value;
  if (createHash("sha256").update(JSON.stringify(withoutEvidenceHash)).digest("hex") !== evidenceHash) invalid("EVIDENCE_HASH");
  if (Array.isArray(value.serviceDays) && value.serviceDays.length === 0) {
    exactKeys(value, PRE_SERVICE_DAY_TOP_LEVEL_KEYS, "PRE_SERVICE_SHAPE");
    if (value.validationStatus !== "MISSING" || value.admissionStatus !== "MISSING"
      || !FAILURE_REASONS.has(value.failureReasonCode)) invalid("PRE_SERVICE_SHAPE");
    return {
      schemaVersion: 1,
      artifactKind: "itx-current-collection-evidence-inspection",
      selectedServiceDates,
      validationStatus: value.validationStatus,
      admissionStatus: value.admissionStatus,
      serviceDayCount: 0,
      aggregate: { expectedOdCount: 0, completedOdCount: 0, failedOdCount: 0 },
      failures: [{ scope: "TOP_LEVEL", failureReasonCode: value.failureReasonCode }],
    };
  }
  if (!object(value.snapshotDiff) || !object(value.sourceTimetableArtifact)
    || !object(value.stationCatalogPackIdentity)) invalid("TOP_LEVEL_SHAPE");
  const hasTopLevelFailure = value.failureStage !== undefined || value.failureReasonCode !== undefined;
  if (hasTopLevelFailure) validateFailure(value.failureStage, value.failureReasonCode, "TOP_LEVEL_SHAPE");
  if (!Array.isArray(value.serviceDays) || value.serviceDays.length !== DAY_CODES.length) invalid("SERVICE_DAY_SHAPE");

  const failures = [];
  if (hasTopLevelFailure) {
    failures.push({ scope: "TOP_LEVEL", failureStage: value.failureStage, failureReasonCode: value.failureReasonCode, failureContexts: [] });
  }
  const seen = new Set();
  let expectedOdCount = 0;
  let completedOdCount = 0;
  let failedOdCount = 0;
  for (const day of value.serviceDays) {
    exactAllowedKeys(day, SERVICE_DAY_KEYS, "SERVICE_DAY_SHAPE");
    if (!DAY_CODES.includes(day.dayCd) || seen.has(day.dayCd) || day.serviceDate !== selectedServiceDates[day.dayCd]
      || !VALIDATION_STATUSES.has(day.status) || !nonnegativeInteger(day.expectedOdCount)
      || !nonnegativeInteger(day.completedOdCount) || !nonnegativeInteger(day.failedOdCount)) invalid("SERVICE_DAY_SHAPE");
    seen.add(day.dayCd);
    expectedOdCount = addSafe(expectedOdCount, day.expectedOdCount);
    completedOdCount = addSafe(completedOdCount, day.completedOdCount);
    failedOdCount = addSafe(failedOdCount, day.failedOdCount);
    const hasFailure = day.failureStage !== undefined || day.failureReasonCode !== undefined || day.failureContext !== undefined;
    if (day.status === "MISSING" && (day.failureStage === undefined || day.failureReasonCode === undefined)) invalid("SERVICE_DAY_SHAPE");
    if (day.status === "SUPPORTED" && hasFailure) invalid("SERVICE_DAY_SHAPE");
    if (hasFailure) {
      validateFailure(day.failureStage, day.failureReasonCode, "SERVICE_DAY_SHAPE");
      failures.push({
        scope: "SERVICE_DAY", dayCd: day.dayCd, failureStage: day.failureStage,
        failureReasonCode: day.failureReasonCode, failureContexts: failureContextInventory(day.failureContext),
      });
    }
  }
  if (seen.size !== DAY_CODES.length) invalid("SERVICE_DAY_SHAPE");
  return {
    schemaVersion: 1,
    artifactKind: "itx-current-collection-evidence-inspection",
    selectedServiceDates,
    validationStatus: value.validationStatus,
    admissionStatus: value.admissionStatus,
    serviceDayCount: value.serviceDays.length,
    aggregate: { expectedOdCount, completedOdCount, failedOdCount },
    failures,
  };
}

function args(argv) {
  if (argv.length !== 2 || argv[0] !== "--evidence" || typeof argv[1] !== "string" || !path.isAbsolute(argv[1])) invalid("ARGUMENT");
  return argv[1];
}

export async function inspectItxCurrentCollectionEvidenceCli({ argv = process.argv.slice(2) } = {}) {
  const evidencePath = args(argv);
  let bytes;
  try {
    bytes = await readEvidenceBytes(evidencePath);
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    invalid("FILE_OPEN");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("JSON");
  }
  return validateEvidence(parsed);
}

export async function readEvidenceBytes(evidencePath, { openFile = open, afterOpen = async () => {} } = {}) {
  let handle;
  try {
    handle = await openFile(evidencePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    invalid("FILE_OPEN");
  }
  try {
    await afterOpen();
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_EVIDENCE_BYTES) invalid("FILE_IDENTITY");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) invalid("FILE_IDENTITY");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) invalid("FILE_IDENTITY");
    return bytes;
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    invalid("FILE_IDENTITY");
  } finally {
    await handle?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await inspectItxCurrentCollectionEvidenceCli())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof DiagnosticError ? error.code : "FILE_OPEN"}\n`);
    process.exitCode = 1;
  }
}
