import { createHash } from "node:crypto";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { planKricNationwideTimetableCollection } from "./plan-kric-nationwide-timetable-collection.mjs";
import { parseCredentialFreeObjectUri, validateLineage } from "./source-snapshot-policy.mjs";

const CANDIDATE_ID = "kric-subway-timetable-exp";
const SOURCE_ID = "kric-subway-timetable";
const TARGET_VERSION = "2026-07-13";
const OPERATION = "subwayTimetableExp";
const ENDPOINT = "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetableExp";
const REQUIRED_EVENT_STRING_FIELDS = ["railOprIsttCd", "lnCd", "stinCd", "dayCd", "trnNo", "arvTm", "dptTm"];
const RESPONSE_SCOPE_FIELDS = ["railOprIsttCd", "lnCd", "stinCd", "dayCd"];

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
  planCollection = planKricNationwideTimetableCollection,
  now = new Date(),
} = {}) {
  const gaps = [];
  const nowMillis = utcMillis(now);
  const plan = validatePlanner({ plannerInputs, requestPlan, planCollection, gaps });
  const reconstructed = validateResponses({ plan, responses, servicePatternByExptCd, gaps });
  const snapshot = validateCurrentSnapshot({ sourceSnapshots, plan, reconstructed, nowMillis, gaps });
  const source = validateSourceInventory(sourceInventory, gaps);
  validateLicenseDecision({ licenseDecision, source, snapshot, gaps });
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
    requestCount: plan?.requestCount ?? 0,
    eventCount: reconstructed?.events.length ?? 0,
    targetSetSha256: plan?.targetSetSha256 ?? null,
    requestPlanSha256: plan?.requestPlanSha256 ?? null,
    eventSetSha256: reconstructed?.eventSetSha256 ?? null,
    servicePatternMappingSha256: reconstructed?.servicePatternMappingSha256 ?? null,
    gaps,
  };
}

function validatePlanner({ plannerInputs, requestPlan, planCollection, gaps }) {
  try {
    const expected = planCollection(plannerInputs);
    if (expected.sourceId !== CANDIDATE_ID || expected.operation !== OPERATION || expected.endpoint !== ENDPOINT
      || expected.targetVersion !== TARGET_VERSION || expected.planOnly !== true || !sameJson(requestPlan, expected)) {
      throw new Error("plan identity");
    }
    const requests = expected.requests;
    if (!Number.isSafeInteger(expected.requestCount) || expected.requestCount !== requests.length) {
      throw new Error("planner request count");
    }
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
    if (targetSet.some(({ dayCds }) => !sameJson(dayCds, ["7", "8", "9"]))) {
      throw new Error("planner target set");
    }
    return {
      requests,
      requestCount: expected.requestCount,
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
  const state = newResponseState();
  responses.forEach((entry) => absorbResponse({ entry, plan, state }));
  state.requestSetInvalid ||= state.responseKeys.size !== plan.requests.length;
  appendResponseGaps(state, gaps);
  const orderedEvents = [...state.events].sort((left, right) => codepointCompare(left.eventKey, right.eventKey));
  const servicePatternMappings = validateServicePatterns({ servicePatternByExptCd, events: orderedEvents });
  if (servicePatternMappings == null) {
    gaps.push(gap("SERVICE_PATTERN_MAPPING_INCOMPLETE"));
  }
  if (state.requestSetInvalid || state.scopeInvalid || state.eventInvalid || servicePatternMappings == null) {
    return null;
  }
  return {
    events: orderedEvents,
    eventSetSha256: sha256(canonicalJson(orderedEvents)),
    servicePatternMappingSha256: sha256(canonicalJson(servicePatternMappings)),
  };
}

function newResponseState() {
  return { events: [], responseKeys: new Set(), eventKeys: new Set(), requestSetInvalid: false, scopeInvalid: false, eventInvalid: false };
}

function absorbResponse({ entry, plan, state }) {
  const request = plan.requestByKey.get(entry?.requestKey);
  if (request == null || state.responseKeys.has(entry.requestKey) || !isSuccessfulResponse(entry, request)) {
    state.requestSetInvalid = true;
    return;
  }
  state.responseKeys.add(entry.requestKey);
  entry.response.body.row.forEach((row) => absorbEvent({ entry, request, row, state }));
}

function isSuccessfulResponse(entry, request) {
  return entry.operation === OPERATION && entry.endpoint === ENDPOINT && sameJson(entry.params, request.params)
    && entry?.response?.header?.resultCode === "00" && Array.isArray(entry?.response?.body?.row)
    && entry.response.body.row.length > 0;
}

function absorbEvent({ entry, request, row, state }) {
  if (!REQUIRED_EVENT_STRING_FIELDS.every((field) => typeof row?.[field] === "string")
    || !RESPONSE_SCOPE_FIELDS.every((field) => nonBlank(row[field])) || !nonBlank(row.trnNo)
    || !validExptCd(row.exptCd)) {
    state.eventInvalid = true;
    return;
  }
  if (RESPONSE_SCOPE_FIELDS.some((field) => row[field] !== request.params[field])) {
    state.scopeInvalid = true;
    return;
  }
  const eventKey = [entry.requestKey, row.trnNo, row.arvTm, row.dptTm, canonicalJson(row.exptCd)].join("|");
  if (state.eventKeys.has(eventKey)) {
    state.eventInvalid = true;
    return;
  }
  state.eventKeys.add(eventKey);
  state.events.push({ requestKey: entry.requestKey, eventKey, ...pickEvent(row) });
}

function appendResponseGaps({ requestSetInvalid, scopeInvalid, eventInvalid }, gaps) {
  if (requestSetInvalid) gaps.push(gap("RESPONSE_SET_INCOMPLETE"));
  if (scopeInvalid) gaps.push(gap("RESPONSE_REQUEST_SCOPE_MISMATCH"));
  if (eventInvalid) gaps.push(gap("TRAIN_EVENT_IDENTITY_MISMATCH"));
}

function validateServicePatterns({ servicePatternByExptCd, events }) {
  if (!Array.isArray(servicePatternByExptCd)) return null;
  const mappings = new Map();
  for (const mapping of servicePatternByExptCd) {
    if (!validExptCd(mapping?.exptCd) || !nonBlank(mapping?.servicePattern) || mappings.has(mapping.exptCd)) return null;
    mappings.set(mapping.exptCd, mapping.servicePattern);
  }
  const eventCodes = [...new Set(events.map(({ exptCd }) => exptCd))].sort(compareExptCd);
  if (mappings.size !== eventCodes.length || !eventCodes.every((exptCd) => mappings.has(exptCd))) return null;
  return [...mappings.entries()].map(([exptCd, servicePattern]) => ({ exptCd, servicePattern }))
    .sort((left, right) => compareExptCd(left.exptCd, right.exptCd));
}

function validateSourceInventory(sourceInventory, gaps) {
  const matches = Array.isArray(sourceInventory?.sources)
    ? sourceInventory.sources.filter((source) => source?.id === SOURCE_ID)
    : [];
  if (matches.length !== 1) {
    gaps.push(gap("SOURCE_INVENTORY_IDENTITY_MISMATCH"));
    return null;
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
  return source;
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

function validateLicenseDecision({ licenseDecision, source, snapshot, gaps }) {
  const decision = licenseDecision ?? {};
  const snapshotBinding = snapshot != null && decision.sourceId === SOURCE_ID
    && decision.snapshotId === snapshot.snapshotId && decision.snapshotRawSha256 === snapshot.rawSha256;
  const inventoryLicenseBinding = nonBlank(source?.license?.type) && decision.licenseId === source.license.type;
  const approvedRights = decision.commercialUseAllowed === true && decision.derivativeWorkAllowed === true
    && decision.redistributionAllowed === true && decision.quotaDecision === "CONFIRMED"
    && decision.productionUseAllowed === true && decision.decision === "APPROVED";
  if (!snapshotBinding || !inventoryLicenseBinding || !approvedRights) {
    gaps.push(gap("LICENSE_PRODUCTION_DECISION_MISSING"));
  }
}

function validateRawReceipt({ rawReceipt, snapshot, nowMillis, gaps }) {
  try {
    assertReceiptBinding(rawReceipt, snapshot, nowMillis);
  } catch {
    gaps.push(gap("OCI_RAW_RECEIPT_MISMATCH"));
  }
}

function assertReceiptBinding(receipt, snapshot, nowMillis) {
  const storedAtMillis = utcMillis(receipt?.storedAt);
  const retentionExpiresAtMillis = utcMillis(receipt?.rawRetentionExpiresAt);
  const validSnapshotBinding = snapshot != null && receipt?.sourceId === SOURCE_ID && receipt.snapshotId === snapshot.snapshotId
    && receipt.snapshotRawSha256 === snapshot.rawSha256 && receipt.rawObjectSha256 === snapshot.rawSha256;
  const validObject = /^[0-9a-f]{64}$/.test(receipt?.rawObjectSha256 ?? "") && Number.isInteger(receipt?.byteSize)
    && receipt.byteSize > 0 && receipt.byteSize === snapshot?.rawByteSize;
  const validRetention = storedAtMillis != null && retentionExpiresAtMillis != null
    && storedAtMillis <= nowMillis && retentionExpiresAtMillis > storedAtMillis && retentionExpiresAtMillis > nowMillis;
  if (!validSnapshotBinding || !validObject || !validRetention) throw new Error("receipt fields");
  const uri = parseCredentialFreeObjectUri(receipt.rawObjectUri, "raw receipt URI");
  const authority = ["oci:", "", receipt.ociNamespace].join("/");
  const expectedUri = [authority, receipt.bucket, receipt.objectKey].join("/");
  if (!uri.uri.startsWith("oci://") || uri.sourceAuthority !== authority || receipt.rawObjectUri !== expectedUri) {
    throw new Error("receipt OCI binding");
  }
}

function gap(code) {
  return { code, status: "PENDING", decision: "CONTRACT_GAP" };
}

function pickEvent(row) {
  return Object.fromEntries([...REQUIRED_EVENT_STRING_FIELDS, "exptCd"].map((field) => [field, row[field]]));
}

function validExptCd(value) {
  return value === null || nonBlank(value);
}

function compareExptCd(left, right) {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return codepointCompare(left, right);
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
  return value != null && typeof value === "object" ? canonicalObject(value) : JSON.stringify(value);
}

function canonicalObject(value) {
  const fields = Object.keys(value).sort(codepointCompare).map((key) => canonicalField(key, value[key]));
  return `{${fields.join(",")}}`;
}

function canonicalField(key, value) {
  return `${JSON.stringify(key)}:${canonicalJson(value)}`;
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
