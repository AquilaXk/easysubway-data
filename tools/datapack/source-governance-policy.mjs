import { createHash } from "node:crypto";

import { deriveFreshness } from "./freshness-policy.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RELEASE_PROTECTION_MAX_AGE_MS = 5 * 60 * 1_000;
const RELEASE_PROTECTION_REASONS = new Set(["ACTIVE_RELEASE", "ROLLBACK_WINDOW"]);
const LICENSE_STATUSES = new Set(["APPROVED", "REVIEW_REQUIRED", "BLOCKED", "EXPIRED"]);
const LEGAL_HOLD_REASONS = new Set(["REGULATORY_AUDIT", "SECURITY_INVESTIGATION", "LEGAL_REQUEST"]);
const GOVERNANCE_REASON_CODES = new Set([
  "SOURCE_LINEAGE_BROKEN",
  "SOURCE_DIFF_MISSING",
  "SOURCE_FRESHNESS_POLICY_MISSING",
  "SOURCE_SNAPSHOT_EXPIRED",
  "RAW_RETENTION_OVERDUE",
  "LEGAL_HOLD_INVALID",
  "LICENSE_REVIEW_REQUIRED",
  "REDISTRIBUTION_NOT_APPROVED",
  "SOURCE_GOVERNANCE_OWNER_MISSING",
]);

export function validateSourceGovernancePolicy({ policy, inventory, freshnessPolicy }) {
  if (policy?.schemaVersion !== 1 || policy?.artifactKind !== "datapack-source-governance-policy") {
    throw new Error("SOURCE_GOVERNANCE_OWNER_MISSING: policy identity");
  }
  requiredUtcDate(policy.policyVersion, "policyVersion");
  const retentionClasses = new Map();
  for (const retentionClass of requiredArray(policy.retentionClasses, "retentionClasses")) {
    const id = requiredRole(retentionClass?.id, "retentionClasses[].id");
    requiredPositiveInteger(retentionClass.retentionDays, `${id}.retentionDays`);
    if (retentionClasses.has(id)) throw new Error(`RAW_RETENTION_OVERDUE: duplicate retention class ${id}`);
    retentionClasses.set(id, retentionClass);
  }

  const inventorySources = new Map();
  for (const source of requiredArray(inventory?.sources, "inventory.sources")) {
    const sourceId = requiredText(source?.id, "inventory source id");
    if (inventorySources.has(sourceId)) {
      throw new Error(`SOURCE_GOVERNANCE_OWNER_MISSING: duplicate inventory source ${sourceId}`);
    }
    inventorySources.set(sourceId, source);
  }
  if (!Array.isArray(policy.sources)) {
    throw new Error("SOURCE_GOVERNANCE_OWNER_MISSING: policy.sources");
  }
  const policySources = new Map();
  for (const entry of policy.sources) {
    validatePolicySource(entry, { inventorySources, retentionClasses, freshnessPolicy });
    if (policySources.has(entry.sourceId)) {
      throw new Error(`SOURCE_GOVERNANCE_OWNER_MISSING: duplicate source ${entry.sourceId}`);
    }
    policySources.set(entry.sourceId, entry);
  }
  for (const source of inventorySources.values()) {
    if (source.requiredForProductionPack === true && !policySources.has(source.id)) {
      throw new Error(`SOURCE_GOVERNANCE_OWNER_MISSING: ${source.id}`);
    }
  }
  validateReasonCodeEscalations(policy.reasonCodeEscalations);
  return { policySources, retentionClasses };
}

export function deriveRawRetentionExpiresAt({ policy, sourceId, retrievedAt }) {
  const entry = policyEntry(policy, sourceId);
  const retentionClass = policy.retentionClasses?.find((candidate) => candidate.id === entry.retentionClassId);
  if (!retentionClass) throw new Error(`RAW_RETENTION_OVERDUE: retention policy ${sourceId}`);
  const retentionDays = requiredPositiveInteger(retentionClass.retentionDays, "retentionDays");
  return new Date(requiredUtcInstant(retrievedAt, "retrievedAt") + retentionDays * DAY_MS).toISOString();
}

export function evaluateSourceGovernance({
  source,
  snapshot,
  policy,
  freshnessPolicy,
  evaluationAt,
  legalHold = null,
  protectedBy = [],
  protectionEvaluatedAt = null,
  purgeEvidence = null,
}) {
  const reasonCodes = new Set();
  const evaluatedMillis = requiredUtcInstant(evaluationAt, "evaluationAt");
  let entry;
  try {
    entry = policyEntry(policy, source?.id);
  } catch {
    reasonCodes.add("SOURCE_GOVERNANCE_OWNER_MISSING");
  }

  if (!entry || !hasRequiredRoles(entry)) {
    reasonCodes.add("SOURCE_GOVERNANCE_OWNER_MISSING");
  }

  if (entry) {
    evaluateFreshness({ entry, snapshot, freshnessPolicy, evaluationAt, reasonCodes });
    evaluateRetention({
      entry,
      snapshot,
      policy,
      evaluatedMillis,
      legalHold,
      protectedBy,
      protectionEvaluatedAt,
      purgeEvidence,
      reasonCodes,
    });
    evaluateLicense({ entry, source, snapshot, evaluatedMillis, reasonCodes });
  }

  const sortedReasonCodes = [...reasonCodes].sort(compareText);
  return {
    sourceId: source?.id ?? snapshot?.sourceId ?? "-",
    snapshotId: snapshot?.snapshotId ?? "-",
    policyVersion: policy?.policyVersion ?? "-",
    decision: sortedReasonCodes.length === 0 ? "GO" : "NO_GO",
    reasonCodes: sortedReasonCodes,
  };
}

export function buildGovernanceSummary({ entries, evaluationAt }) {
  const results = requiredArray(entries, "entries")
    .map((entry) => evaluateSourceGovernance({ ...entry, evaluationAt }))
    .sort((left, right) => compareText(left.sourceId, right.sourceId));
  const body = {
    schemaVersion: 1,
    artifactKind: "datapack-source-governance-summary",
    evaluatedAt: new Date(requiredUtcInstant(evaluationAt, "evaluationAt")).toISOString(),
    decision: results.every((result) => result.decision === "GO") ? "GO" : "NO_GO",
    reasonCodes: [...new Set(results.flatMap((result) => result.reasonCodes))].sort(compareText),
    sources: results,
  };
  return { ...body, summarySha256: sha256(JSON.stringify(body)) };
}

export function isValidLegalHold({ hold, policy, sourceId, snapshotId, evaluationAt }) {
  try {
    return validateLegalHold(
      hold,
      policyEntry(policy, sourceId),
      { snapshotId },
      requiredUtcInstant(evaluationAt, "evaluationAt"),
    );
  } catch {
    return false;
  }
}

function validatePolicySource(entry, { inventorySources, retentionClasses, freshnessPolicy }) {
  const sourceId = requiredText(entry?.sourceId, "sourceId");
  const source = inventorySources.get(sourceId);
  if (!source) throw new Error(`SOURCE_GOVERNANCE_OWNER_MISSING: unknown source ${sourceId}`);
  const sourceClassId = requiredIdentifier(entry.sourceClassId, `${sourceId}.sourceClassId`);
  const sourceClass = freshnessPolicy?.sourceClasses?.find((candidate) => candidate.id === sourceClassId);
  if (!sourceClass || !sourceClass.sourceIds?.includes(sourceId)) {
    throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: ${sourceId}`);
  }
  if (!retentionClasses.has(requiredRole(entry.retentionClassId, `${sourceId}.retentionClassId`))) {
    throw new Error(`RAW_RETENTION_OVERDUE: ${sourceId}`);
  }
  if (!hasRequiredRoles(entry)) throw new Error(`SOURCE_GOVERNANCE_OWNER_MISSING: ${sourceId}`);
  requiredPositiveInteger(entry.escalationHours, `${sourceId}.escalationHours`);
  requiredText(entry.alertRoute, `${sourceId}.alertRoute`);
  validateLicenseReview(entry.licenseReview, entry, sourceId);
  if (!isSha256(source.admissionEvidence?.licenseEvidenceHash)) {
    throw new Error(`LICENSE_REVIEW_REQUIRED: ${sourceId}.licenseEvidenceHash`);
  }
}

function validateReasonCodeEscalations(escalations) {
  const found = new Set();
  for (const escalation of requiredArray(escalations, "reasonCodeEscalations")) {
    requiredRole(escalation?.responsibleRole, "reasonCodeEscalations[].responsibleRole");
    requiredText(escalation.alertRoute, "reasonCodeEscalations[].alertRoute");
    requiredPositiveInteger(escalation.escalationHours, "reasonCodeEscalations[].escalationHours");
    for (const reasonCode of requiredArray(escalation.reasonCodes, "reasonCodeEscalations[].reasonCodes")) {
      if (!GOVERNANCE_REASON_CODES.has(reasonCode) || found.has(reasonCode)) {
        throw new Error(`SOURCE_GOVERNANCE_OWNER_MISSING: reason code escalation ${reasonCode}`);
      }
      found.add(reasonCode);
    }
  }
  if (found.size !== GOVERNANCE_REASON_CODES.size) {
    throw new Error("SOURCE_GOVERNANCE_OWNER_MISSING: incomplete reason code escalation");
  }
}

function validateLicenseReview(review, entry, sourceId) {
  if (!review || !LICENSE_STATUSES.has(review.status)) {
    throw new Error(`LICENSE_REVIEW_REQUIRED: ${sourceId}.status`);
  }
  requiredSha256(review.termsHash, `${sourceId}.termsHash`);
  const reviewedAt = requiredUtcInstant(review.reviewedAt, `${sourceId}.reviewedAt`);
  const nextReviewAt = requiredUtcInstant(review.nextReviewAt, `${sourceId}.nextReviewAt`);
  if (nextReviewAt <= reviewedAt) throw new Error(`LICENSE_REVIEW_REQUIRED: ${sourceId}.nextReviewAt`);
  requiredHttpsUrl(review.termsUrl, `${sourceId}.termsUrl`);
  requiredText(review.reviewedProvider, `${sourceId}.reviewedProvider`);
  requiredHttpsUrl(review.reviewedDatasetUrl, `${sourceId}.reviewedDatasetUrl`);
  if (!requiredArray(review.redistributionScopes, `${sourceId}.redistributionScopes`).includes("DERIVED_DATAPACK")) {
    throw new Error(`REDISTRIBUTION_NOT_APPROVED: ${sourceId}`);
  }
  if (review.approvedByRole !== entry.approvalRole) {
    throw new Error(`LICENSE_REVIEW_REQUIRED: ${sourceId}.approvedByRole`);
  }
}

function evaluateFreshness({ entry, snapshot, freshnessPolicy, evaluationAt, reasonCodes }) {
  const sourceClass = freshnessPolicy?.sourceClasses?.find((candidate) => candidate.id === entry.sourceClassId);
  if (!sourceClass || !sourceClass.sourceIds?.includes(entry.sourceId)) {
    reasonCodes.add("SOURCE_FRESHNESS_POLICY_MISSING");
    return;
  }
  try {
    const result = deriveFreshness({
      policy: freshnessPolicy,
      sourceClassId: entry.sourceClassId,
      basisAt: snapshot?.[sourceClass.basisField],
      providerValidUntil: sourceClass.providerValidityEndField
        ? snapshot?.[sourceClass.providerValidityEndField]
        : undefined,
      storedExpiresAt: snapshot?.freshnessExpiresAt,
      evaluationAt,
    });
    for (const reasonCode of result.reasonCodes) reasonCodes.add(reasonCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reasonCodes.add(message.startsWith("SOURCE_SNAPSHOT_EXPIRED")
      ? "SOURCE_SNAPSHOT_EXPIRED"
      : "SOURCE_FRESHNESS_POLICY_MISSING");
  }
}

function evaluateRetention({
  entry,
  snapshot,
  policy,
  evaluatedMillis,
  legalHold,
  protectedBy,
  protectionEvaluatedAt,
  purgeEvidence,
  reasonCodes,
}) {
  let storedMillis;
  try {
    const derived = deriveRawRetentionExpiresAt({
      policy,
      sourceId: entry.sourceId,
      retrievedAt: snapshot?.retrievedAt,
    });
    storedMillis = requiredUtcInstant(snapshot?.rawRetentionExpiresAt, "rawRetentionExpiresAt");
    if (new Date(storedMillis).toISOString() !== derived) reasonCodes.add("RAW_RETENTION_OVERDUE");
  } catch {
    reasonCodes.add("RAW_RETENTION_OVERDUE");
    return;
  }

  const holdValid = legalHold == null ? false : validateLegalHold(legalHold, entry, snapshot, evaluatedMillis);
  if (legalHold != null && !holdValid) reasonCodes.add("LEGAL_HOLD_INVALID");
  const validProtection = Array.isArray(protectedBy)
    && new Set(protectedBy).size === protectedBy.length
    && protectedBy.every((reason) => RELEASE_PROTECTION_REASONS.has(reason));
  if (!validProtection) reasonCodes.add("RAW_RETENTION_OVERDUE");
  let protectionIsCurrent = false;
  try {
    const protectionMillis = requiredUtcInstant(protectionEvaluatedAt, "protectionEvaluatedAt");
    protectionIsCurrent = protectionMillis <= evaluatedMillis
      && evaluatedMillis - protectionMillis <= RELEASE_PROTECTION_MAX_AGE_MS;
  } catch {
    protectionIsCurrent = false;
  }
  const hasReleaseProtection = validProtection && protectedBy.length > 0;
  if (hasReleaseProtection && !protectionIsCurrent) reasonCodes.add("RAW_RETENTION_OVERDUE");
  const releaseProtected = hasReleaseProtection && protectionIsCurrent;
  const purgeCompleted = validPurgeEvidence(purgeEvidence, entry, snapshot, storedMillis, evaluatedMillis);
  if (evaluatedMillis >= storedMillis && !releaseProtected && !holdValid && !purgeCompleted) {
    reasonCodes.add("RAW_RETENTION_OVERDUE");
  }
}

function validPurgeEvidence(evidence, entry, snapshot, storedMillis, evaluatedMillis) {
  if (evidence?.sourceId !== entry.sourceId
    || evidence.snapshotId !== snapshot?.snapshotId
    || evidence.rawSha256 !== snapshot?.rawSha256) {
    return false;
  }
  try {
    const purgedMillis = requiredUtcInstant(evidence.purgedAt, "purgedAt");
    return purgedMillis >= storedMillis && purgedMillis <= evaluatedMillis;
  } catch {
    return false;
  }
}

function evaluateLicense({ entry, source, snapshot, evaluatedMillis, reasonCodes }) {
  const review = entry.licenseReview;
  let reviewedMillis = Number.NaN;
  let nextReviewMillis = Number.NaN;
  try {
    reviewedMillis = requiredUtcInstant(review?.reviewedAt, "licenseReview.reviewedAt");
    nextReviewMillis = requiredUtcInstant(review?.nextReviewAt, "licenseReview.nextReviewAt");
  } catch {
    // Invalid review timestamps are handled by the fail-closed predicate below.
  }
  const reviewRequired = review?.status !== "APPROVED"
    || !isSha256(review?.termsHash)
    || review.termsHash !== source?.admissionEvidence?.licenseEvidenceHash
    || review.reviewedProvider !== source?.provider
    || review.reviewedDatasetUrl !== source?.datasetUrl
    || review.approvedByRole !== entry.approvalRole
    || !Number.isFinite(reviewedMillis)
    || !Number.isFinite(nextReviewMillis)
    || reviewedMillis > evaluatedMillis
    || reviewedMillis >= nextReviewMillis
    || evaluatedMillis >= nextReviewMillis;
  if (reviewRequired) reasonCodes.add("LICENSE_REVIEW_REQUIRED");

  if (
    source?.license?.redistributionAllowed !== true
    || snapshot?.redistributionAllowed !== true
    || !review?.redistributionScopes?.includes("DERIVED_DATAPACK")
  ) {
    reasonCodes.add("REDISTRIBUTION_NOT_APPROVED");
  }
}

function validateLegalHold(hold, entry, snapshot, evaluatedMillis) {
  try {
    if (hold.sourceId !== entry.sourceId || hold.snapshotId !== snapshot?.snapshotId) return false;
    if (hold.ownerRole !== entry.ownerRole || !LEGAL_HOLD_REASONS.has(hold.reasonCode)) return false;
    const createdMillis = requiredUtcInstant(hold.createdAt, "legalHold.createdAt");
    const expiresMillis = requiredUtcInstant(hold.expiresAt, "legalHold.expiresAt");
    return createdMillis <= evaluatedMillis
      && expiresMillis > createdMillis
      && evaluatedMillis < expiresMillis;
  } catch {
    return false;
  }
}

function policyEntry(policy, sourceId) {
  const matches = policy?.sources?.filter((entry) => entry.sourceId === sourceId) ?? [];
  if (matches.length !== 1) throw new Error(`SOURCE_GOVERNANCE_OWNER_MISSING: ${sourceId ?? "source"}`);
  return matches[0];
}

function hasRequiredRoles(entry) {
  return [entry?.ownerRole, entry?.stewardRole, entry?.approvalRole].every(isRole);
}

function isRole(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value);
}

function requiredRole(value, label) {
  if (!isRole(value)) throw new Error(`SOURCE_GOVERNANCE_OWNER_MISSING: ${label}`);
  return value;
}

function requiredIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: ${label}`);
  }
  return value;
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function requiredUtcDate(value, label) {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) throw new Error(`${label} must be a UTC date`);
  const millis = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a UTC date`);
  }
  return value;
}

function requiredArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requiredSha256(value, label) {
  if (!isSha256(value)) throw new Error(`${label} must be a sha256 hex string`);
  return value;
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function requiredHttpsUrl(value, label) {
  const raw = requiredText(value, label);
  if (!/^[A-Za-z0-9:/?#\[\]@!$&'()*+,;=._~%\-]+$/.test(raw)
    || /%(?![0-9A-Fa-f]{2})/.test(raw)) {
    throw new Error(`${label} must be a valid URL`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return codepointCompare(left, right);
}
