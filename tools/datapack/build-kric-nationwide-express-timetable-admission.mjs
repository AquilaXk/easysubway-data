import { createHash } from "node:crypto";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { planKricNationwideTimetableCollection } from "./plan-kric-nationwide-timetable-collection.mjs";
import { parseCredentialFreeObjectUri, validateLineage } from "./source-snapshot-policy.mjs";

const CANDIDATE_ID = "kric-subway-timetable-exp";
const SOURCE_ID = "kric-subway-timetable";
const TARGET_VERSION = "2026-07-13";
const OPERATION = "subwayTimetableExp";
const ENDPOINT = "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetableExp";
const REQUIRED_EVENT_FIELDS = ["railOprIsttCd", "lnCd", "stinCd", "dayCd", "trnNo", "arvTm", "dptTm", "exptCd"];

/**
 * Evaluates current-operation evidence for #454. It intentionally never
 * admits, writes, publishes, or registers timetable data.
 */
export function buildKricNationwideExpressTimetableAdmissionContract({
  plannerInputs,
  requestPlan,
  responses,
  servicePatternByExptCd,
  sourceInventory,
  sourceSnapshots,
  rawReceipt,
  licenseDecision,
  now = new Date(),
} = {}) {
  const gaps = [];
  const nowMillis = utcMillis(now);
  const plan = validatePlanner({ plannerInputs, requestPlan, gaps });
  const reconstructed = validateResponses({ plan, responses, servicePatternByExptCd, gaps });
  const snapshot = validateCurrentSnapshot({ sourceSnapshots, plan, reconstructed, nowMillis, gaps });
  validateSourceInventory(sourceInventory, gaps);
  validateLicenseDecision({ licenseDecision, snapshot, gaps });
  validateRawReceipt({ rawReceipt, snapshot, nowMillis, gaps });

  if (gaps.length === 0 && plan != null && reconstructed != null && snapshot != null) {
    gaps.push(gap("ADMISSION_EXECUTION_REQUIRED"));
  }
  return {
    schemaVersion: 1,
    artifactKind: "kric-nationwide-express-timetable-admission-contract",
    status: "PENDING",
    decision: "CONTRACT_GAP",
    sourceId: SOURCE_ID,
    candidateId: CANDIDATE_ID,
    targetVersion: TARGET_VERSION,
    targetSetCount: plan?.targetSet.length ?? 0,
    requestCount: plan?.requests.length ?? 0,
    eventCount: reconstructed?.events.length ?? 0,
    targetSetSha256: plan?.targetSetSha256 ?? null,
    requestPlanSha256: plan?.requestPlanSha256 ?? null,
    eventSetSha256: reconstructed?.eventSetSha256 ?? null,
    servicePatternMappingSha256: reconstructed?.servicePatternMappingSha256 ?? null,
    gaps,
  };
}

function validatePlanner({ plannerInputs, requestPlan, gaps }) {
  try {
    const expected = planKricNationwideTimetableCollection(plannerInputs);
    if (expected.sourceId !== CANDIDATE_ID || expected.operation !== OPERATION || expected.endpoint !== ENDPOINT
      || expected.targetVersion !== TARGET_VERSION || expected.planOnly !== true || !sameJson(requestPlan, expected)) {
      throw new Error("plan identity");
    }
    const requests = expected.requests;
    const requestKeys = new Set();
    const targets = new Map();
    for (const request of requests) {
      const { railOprIsttCd, lnCd, stinCd, dayCd, format } = request?.params ?? {};
      if (request?.operation !== OPERATION || request.endpoint !== ENDPOINT || format !== "json"
        || !["8", "7", "9"].includes(dayCd) || ![railOprIsttCd, lnCd, stinCd].every(nonBlank)
        || request.requestKey !== `${OPERATION}|${railOprIsttCd}|${lnCd}|${stinCd}|${dayCd}`
        || requestKeys.has(request.requestKey)) {
        throw new Error("request identity");
      }
      requestKeys.add(request.requestKey);
      const key = `${railOprIsttCd}|${lnCd}|${stinCd}`;
      const target = targets.get(key) ?? { railOprIsttCd, lnCd, stinCd, dayCds: [] };
      target.dayCds.push(dayCd);
      targets.set(key, target);
    }
    const targetSet = [...targets.values()].map((target) => ({
      ...target,
      dayCds: [...target.dayCds].sort(codepointCompare),
    })).sort(compareTarget);
    if (requests.length !== 48 || targetSet.length !== 16 || targetSet.some(({ dayCds }) => !sameJson(dayCds, ["7", "8", "9"]))) {
      throw new Error("planner target set");
    }
    return {
      requests,
      requestByKey: new Map(requests.map((request) => [request.requestKey, request])),
      targetSet,
      targetSetSha256: sha256(canonicalJson(targetSet)),
      requestPlanSha256: sha256(canonicalJson(requests)),
    };
  } catch {
    gaps.push(gap("PLANNER_TARGET_OR_HASH_MISMATCH"));
    return null;
  }
}

function validateResponses({ plan, responses, servicePatternByExptCd, gaps }) {
  if (plan == null || !Array.isArray(responses)) {
    gaps.push(gap("RESPONSE_SET_INCOMPLETE"));
    return null;
  }
  const events = [];
  const responseKeys = new Set();
  const eventKeys = new Set();
  let requestSetInvalid = false;
  let scopeInvalid = false;
  let eventInvalid = false;
  for (const responseEntry of responses) {
    const request = plan.requestByKey.get(responseEntry?.requestKey);
    if (request == null || responseKeys.has(responseEntry.requestKey)) {
      requestSetInvalid = true;
      continue;
    }
    responseKeys.add(responseEntry.requestKey);
    if (responseEntry.operation !== OPERATION || responseEntry.endpoint !== ENDPOINT || !sameJson(responseEntry.params, request.params)
      || responseEntry?.response?.header?.resultCode !== "00" || !Array.isArray(responseEntry?.response?.body?.row)
      || responseEntry.response.body.row.length === 0) {
      requestSetInvalid = true;
      continue;
    }
    for (const row of responseEntry.response.body.row) {
      if (!REQUIRED_EVENT_FIELDS.every((field) => typeof row?.[field] === "string")
        || !["railOprIsttCd", "lnCd", "stinCd", "dayCd"].every((field) => nonBlank(row[field]))) {
        eventInvalid = true;
        continue;
      }
      if (["railOprIsttCd", "lnCd", "stinCd", "dayCd"].some((field) => row[field] !== request.params[field])) {
        scopeInvalid = true;
        continue;
      }
      const eventKey = [responseEntry.requestKey, row.trnNo, row.arvTm, row.dptTm, row.exptCd].join("|");
      if (eventKeys.has(eventKey)) {
        eventInvalid = true;
        continue;
      }
      eventKeys.add(eventKey);
      events.push({ requestKey: responseEntry.requestKey, eventKey, ...pickEvent(row) });
    }
  }
  if (responseKeys.size !== plan.requests.length) requestSetInvalid = true;
  if (requestSetInvalid) gaps.push(gap("RESPONSE_SET_INCOMPLETE"));
  if (scopeInvalid) gaps.push(gap("RESPONSE_REQUEST_SCOPE_MISMATCH"));
  if (eventInvalid) gaps.push(gap("TRAIN_EVENT_IDENTITY_MISMATCH"));
  const orderedEvents = [...events].sort((left, right) => codepointCompare(left.eventKey, right.eventKey));
  const servicePatternMappings = validateServicePatterns({ servicePatternByExptCd, events: orderedEvents });
  if (servicePatternMappings == null) {
    gaps.push(gap("SERVICE_PATTERN_MAPPING_INCOMPLETE"));
  }
  if (requestSetInvalid || scopeInvalid || eventInvalid || servicePatternMappings == null) {
    return null;
  }
  return {
    events: orderedEvents,
    eventSetSha256: sha256(canonicalJson(orderedEvents)),
    servicePatternMappingSha256: sha256(canonicalJson(servicePatternMappings)),
  };
}

function validateServicePatterns({ servicePatternByExptCd, events }) {
  if (!Array.isArray(servicePatternByExptCd)) return null;
  const mappings = new Map();
  for (const mapping of servicePatternByExptCd) {
    if (typeof mapping?.exptCd !== "string" || !nonBlank(mapping?.servicePattern) || mappings.has(mapping.exptCd)) return null;
    mappings.set(mapping.exptCd, mapping.servicePattern);
  }
  const eventCodes = [...new Set(events.map(({ exptCd }) => exptCd))].sort(codepointCompare);
  if (mappings.size !== eventCodes.length || !eventCodes.every((exptCd) => mappings.has(exptCd))) return null;
  return [...mappings.entries()].map(([exptCd, servicePattern]) => ({ exptCd, servicePattern }))
    .sort((left, right) => codepointCompare(left.exptCd, right.exptCd));
}

function validateSourceInventory(sourceInventory, gaps) {
  const matches = Array.isArray(sourceInventory?.sources)
    ? sourceInventory.sources.filter(({ id }) => id === SOURCE_ID)
    : [];
  if (matches.length !== 1) {
    gaps.push(gap("SOURCE_INVENTORY_IDENTITY_MISMATCH"));
    return;
  }
  const [source] = matches;
  if (source.coverageScope?.sourceDomains?.length !== 1 || source.coverageScope.sourceDomains[0] !== "schedule_timetable") {
    gaps.push(gap("SOURCE_INVENTORY_PRODUCTION_SCOPE_MISSING"));
  }
  if (!sameSorted(source.fieldsProvided, ["arvTm", "dayCd", "dayNm", "dptTm", "exptCd", "lnCd", "railOprIsttCd", "stinCd", "trnNo"])
    || source.license?.commercialUseAllowed !== true || source.license?.derivativeWorkAllowed !== true
    || source.license?.redistributionAllowed !== true) {
    gaps.push(gap("SOURCE_REQUIRED_FIELDS_OR_LICENSE_INCOMPLETE"));
  }
}

function validateCurrentSnapshot({ sourceSnapshots, plan, reconstructed, nowMillis, gaps }) {
  const snapshots = Array.isArray(sourceSnapshots) ? sourceSnapshots : [];
  let lineage;
  try {
    lineage = validateLineage(snapshots);
  } catch {
    gaps.push(gap("SOURCE_LINEAGE_OR_DIFF_INVALID"));
    return null;
  }
  const sourceEntries = snapshots.filter((snapshot) => snapshot?.sourceId === SOURCE_ID);
  const snapshot = sourceEntries.find(({ snapshotId }) => snapshotId === lineage.headsBySource[SOURCE_ID]);
  if (sourceEntries.length === 0 || snapshot == null || utcMillis(snapshot.retrievedAt) == null
    || utcMillis(snapshot.retrievedAt) > nowMillis || utcMillis(snapshot.freshUntil) == null
    || utcMillis(snapshot.freshUntil) <= nowMillis || utcMillis(snapshot.sourceUpdatedAt) == null
    || utcMillis(snapshot.sourceUpdatedAt) > nowMillis) {
    gaps.push(gap("SNAPSHOT_NOT_CURRENT"));
    return null;
  }
  if (plan == null || reconstructed == null || snapshot.coverageCount !== plan.targetSet.length
    || snapshot.rowCount !== reconstructed.events.length || snapshot.requestPlanSha256 !== plan.requestPlanSha256
    || snapshot.targetSetSha256 !== plan.targetSetSha256 || snapshot.eventSetSha256 !== reconstructed.eventSetSha256
    || snapshot.servicePatternMappingSha256 !== reconstructed.servicePatternMappingSha256) {
    gaps.push(gap("SNAPSHOT_PLAN_OR_EVENT_BINDING_MISMATCH"));
    return null;
  }
  return snapshot;
}

function validateLicenseDecision({ licenseDecision, snapshot, gaps }) {
  if (snapshot == null || licenseDecision?.sourceId !== SOURCE_ID || licenseDecision.snapshotId !== snapshot.snapshotId
    || licenseDecision.snapshotRawSha256 !== snapshot.rawSha256 || !nonBlank(licenseDecision.licenseId)
    || licenseDecision.commercialUseAllowed !== true || licenseDecision.derivativeWorkAllowed !== true
    || licenseDecision.redistributionAllowed !== true || licenseDecision.quotaDecision !== "CONFIRMED"
    || licenseDecision.productionUseAllowed !== true || licenseDecision.decision !== "APPROVED") {
    gaps.push(gap("LICENSE_PRODUCTION_DECISION_MISSING"));
  }
}

function validateRawReceipt({ rawReceipt, snapshot, nowMillis, gaps }) {
  try {
    const storedAtMillis = utcMillis(rawReceipt?.storedAt);
    const retentionExpiresAtMillis = utcMillis(rawReceipt?.rawRetentionExpiresAt);
    if (snapshot == null || rawReceipt?.sourceId !== SOURCE_ID || rawReceipt.snapshotId !== snapshot.snapshotId
      || rawReceipt.snapshotRawSha256 !== snapshot.rawSha256 || rawReceipt.rawObjectSha256 !== snapshot.rawSha256
      || !/^[0-9a-f]{64}$/.test(rawReceipt.rawObjectSha256 ?? "") || !Number.isInteger(rawReceipt.byteSize)
      || rawReceipt.byteSize <= 0 || rawReceipt.byteSize !== snapshot.rawByteSize
      || storedAtMillis == null || retentionExpiresAtMillis == null
      || retentionExpiresAtMillis <= storedAtMillis || retentionExpiresAtMillis <= nowMillis) {
      throw new Error("receipt fields");
    }
    const uri = parseCredentialFreeObjectUri(rawReceipt.rawObjectUri, "raw receipt URI");
    if (!uri.uri.startsWith("oci://") || uri.sourceAuthority !== `oci://${rawReceipt.ociNamespace}`
      || rawReceipt.rawObjectUri !== `oci://${rawReceipt.ociNamespace}/${rawReceipt.bucket}/${rawReceipt.objectKey}`) {
      throw new Error("receipt OCI binding");
    }
  } catch {
    gaps.push(gap("OCI_RAW_RECEIPT_MISMATCH"));
  }
}

function gap(code) {
  return { code, status: "PENDING", decision: "CONTRACT_GAP" };
}

function pickEvent(row) {
  return Object.fromEntries(REQUIRED_EVENT_FIELDS.map((field) => [field, row[field]]));
}

function compareTarget(left, right) {
  return codepointCompare(left.railOprIsttCd, right.railOprIsttCd)
    || codepointCompare(left.lnCd, right.lnCd)
    || codepointCompare(left.stinCd, right.stinCd);
}

function sameSorted(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && [...actual].sort(codepointCompare).every((value, index) => value === [...expected].sort(codepointCompare)[index]);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    return `{${Object.keys(value).sort(codepointCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function utcMillis(value) {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function nonBlank(value) {
  return typeof value === "string" && value.trim() !== "";
}
