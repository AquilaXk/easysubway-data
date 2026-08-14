import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EXTENSION_INPUT_KEYS = [
  "artifactKind",
  "evaluationAt",
  "observation",
  "policyBinding",
  "schemaVersion",
  "sourceIdentity",
];
const SOURCE_IDENTITY_KEYS = [
  "currentFreshUntil",
  "rawEvidenceSha256",
  "snapshotId",
  "snapshotSha256",
  "sourceId",
];
const POLICY_BINDING_KEYS = ["policySha256", "sourceClassId"];
const OBSERVATION_KEYS = [
  "artifactKind",
  "evidenceSha256",
  "licenseValidUntil",
  "observedAt",
  "outcome",
  "providerValidUntil",
  "rawEvidenceSha256",
  "schemaVersion",
  "snapshotId",
  "snapshotSha256",
  "sourceId",
  "sourceValidUntil",
];
const OBSERVATION_OUTCOMES = new Set(["POSITIVE", "NO_CHANGE", "NEGATIVE", "UNKNOWN"]);

export function deriveFreshness({
  policy,
  sourceClassId,
  basisAt,
  providerValidUntil,
  storedExpiresAt,
  evaluationAt,
}) {
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy,
    sourceClassId,
    basisAt,
    providerValidUntil,
    evaluationAt,
  });
  const evaluatedMillis = requiredUtcInstant(evaluationAt, "evaluationAt");
  const derivedMillis = requiredUtcInstant(freshnessExpiresAt, "freshnessExpiresAt");
  const storedMillis = requiredUtcInstant(storedExpiresAt, "storedExpiresAt");
  if (storedMillis !== derivedMillis) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH");
  }

  const stale = evaluatedMillis >= derivedMillis;
  return {
    status: stale ? "STALE" : "FRESH",
    freshnessExpiresAt,
    reasonCodes: stale ? ["SOURCE_SNAPSHOT_EXPIRED"] : [],
  };
}

export function deriveFreshnessExpiresAt({
  policy,
  sourceClassId,
  basisAt,
  providerValidUntil,
  evaluationAt,
}) {
  const sourceClass = policy?.sourceClasses?.find((entry) => entry.id === sourceClassId);
  if (!sourceClass || !basisAt) {
    throw new Error("SOURCE_FRESHNESS_POLICY_MISSING");
  }

  const evaluatedMillis = requiredUtcInstant(evaluationAt, "evaluationAt");
  const basisMillis = requiredUtcInstant(basisAt, "basisAt");
  const clockSkewMillis = requiredNonNegativeInteger(
    sourceClass.clockSkewSeconds ?? policy.clockSkewSeconds ?? 0,
    "clockSkewSeconds",
  ) * 1_000;
  if (sourceClass.futureBasisAllowed !== true && basisMillis > evaluatedMillis + clockSkewMillis) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: basisAt exceeds clock skew");
  }

  const cadence = sourceClass.reverificationCadence ?? sourceClass.maximumReverificationCadence;
  let derivedMillis = addCadence(basisMillis, cadence);
  if (providerValidUntil != null) {
    derivedMillis = Math.min(derivedMillis, requiredUtcInstant(providerValidUntil, "providerValidUntil"));
  }
  return new Date(derivedMillis).toISOString();
}

export function freshnessPolicySha256(policy) {
  return sha256(Buffer.from(canonicalJson(policy), "utf8"));
}

export function evaluateFreshnessExtension({ input, policy, now = Date.now() } = {}) {
  const context = extensionResultContext(input);
  if (!validExtensionInputEnvelope(input)) {
    return extensionResult(context, "INELIGIBLE", "INPUT_SCHEMA_INVALID");
  }

  const trustedNowMillis = Number.isSafeInteger(now) ? now : Number.NaN;
  if (!Number.isFinite(trustedNowMillis)) {
    return extensionResult(context, "INELIGIBLE", "INPUT_SCHEMA_INVALID");
  }

  const timeline = resolveExtensionTimeline(input, context);
  if (timeline.failure) return resultFromFailure(context, timeline.failure);

  const policyResolution = resolveExtensionPolicy(
    policy,
    input,
    timeline.evaluationMillis,
    trustedNowMillis,
  );
  if (policyResolution.failure) return resultFromFailure(context, policyResolution.failure);

  return evaluateExtensionObservation({ input, context, timeline, policyResolution });
}

export function decideScheduledRun({
  materialChange,
  approvalValid,
  strictValidationPassed,
  publishRequired,
  publishAttempted,
  remoteValidationPassed,
}) {
  if (!strictValidationPassed) return decision("FAILED", false);
  if (materialChange && !approvalValid) return decision("CHANGE_BLOCKED", false);
  if (publishRequired && !publishAttempted) return decision("PUBLISH_REQUIRED", approvalValid);
  if (publishAttempted) {
    if (!approvalValid) return decision("FAILED", false);
    return remoteValidationPassed
      ? decision("PUBLISHED_AND_VERIFIED", true)
      : decision("FAILED", false);
  }
  return decision("NO_CHANGE_VALID", false);
}

export function addCadence(basisMillis, cadence) {
  if (typeof cadence !== "string") {
    throw new Error("SOURCE_FRESHNESS_POLICY_MISSING: cadence");
  }
  const days = /^P([1-9][0-9]*)D$/.exec(cadence);
  if (days) return basisMillis + Number(days[1]) * DAY_MS;
  const years = /^P([1-9][0-9]*)Y$/.exec(cadence);
  if (years) {
    const value = new Date(basisMillis);
    value.setUTCFullYear(value.getUTCFullYear() + Number(years[1]));
    return value.getTime();
  }
  const seconds = /^PT([1-9][0-9]*)S$/.exec(cadence);
  if (seconds) return basisMillis + Number(seconds[1]) * 1_000;
  throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: unsupported cadence ${cadence}`);
}

function requiredNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function validExtensionInputEnvelope(input) {
  return hasExactKeys(input, EXTENSION_INPUT_KEYS)
    && input.schemaVersion === 1
    && input.artifactKind === "source-freshness-extension-input"
    && typeof input.evaluationAt === "string"
    && validSourceIdentity(input.sourceIdentity)
    && hasExactKeys(input.policyBinding, POLICY_BINDING_KEYS)
    && nonEmptyString(input.policyBinding.sourceClassId)
    && SHA256_PATTERN.test(input.policyBinding.policySha256)
    && (input.observation == null || isRecord(input.observation));
}

function validSourceIdentity(identity) {
  return hasExactKeys(identity, SOURCE_IDENTITY_KEYS)
    && nonEmptyString(identity.sourceId)
    && nonEmptyString(identity.snapshotId)
    && SHA256_PATTERN.test(identity.snapshotSha256)
    && SHA256_PATTERN.test(identity.rawEvidenceSha256)
    && typeof identity.currentFreshUntil === "string";
}

function validObservation(observation) {
  return hasExactKeys(observation, OBSERVATION_KEYS)
    && observation.schemaVersion === 1
    && observation.artifactKind === "source-freshness-observation"
    && OBSERVATION_OUTCOMES.has(observation.outcome)
    && nonEmptyString(observation.sourceId)
    && nonEmptyString(observation.snapshotId)
    && SHA256_PATTERN.test(observation.snapshotSha256)
    && SHA256_PATTERN.test(observation.rawEvidenceSha256)
    && typeof observation.observedAt === "string"
    && SHA256_PATTERN.test(observation.evidenceSha256)
    && [
      observation.providerValidUntil,
      observation.sourceValidUntil,
      observation.licenseValidUntil,
    ].every((value) => value == null || typeof value === "string");
}

function resolveExtensionTimeline(input, context) {
  try {
    const evaluationMillis = requiredUtcInstant(input.evaluationAt, "evaluationAt");
    const currentFreshUntilMillis = requiredUtcInstant(
      input.sourceIdentity.currentFreshUntil,
      "sourceIdentity.currentFreshUntil",
    );
    context.evaluatedAt = new Date(evaluationMillis).toISOString();
    context.currentFreshUntil = new Date(currentFreshUntilMillis).toISOString();
    return { evaluationMillis, currentFreshUntilMillis };
  } catch {
    return { failure: extensionFailure("INELIGIBLE", "INPUT_SCHEMA_INVALID") };
  }
}

function resolveExtensionPolicy(policy, input, evaluationMillis, trustedNowMillis) {
  if (!isRecord(policy) || policy.schemaVersion !== 2) {
    return { failure: extensionFailure("INELIGIBLE", "POLICY_SCHEMA_INVALID") };
  }
  let actualPolicySha256;
  try {
    actualPolicySha256 = freshnessPolicySha256(policy);
  } catch {
    return { failure: extensionFailure("INELIGIBLE", "POLICY_SCHEMA_INVALID") };
  }
  if (input.policyBinding.policySha256 !== actualPolicySha256) {
    return { failure: extensionFailure("INELIGIBLE", "POLICY_IDENTITY_MISMATCH") };
  }

  const sourceClass = exactSourceClass(policy, input.policyBinding.sourceClassId);
  if (!sourceClass || !sourceClass.sourceIds.includes(input.sourceIdentity.sourceId)) {
    return { failure: extensionFailure("INELIGIBLE", "SOURCE_CLASS_INELIGIBLE") };
  }

  const cadence = sourceClass.reverificationCadence ?? sourceClass.maximumReverificationCadence;
  try {
    const clockSkewMillis = requiredNonNegativeInteger(
      sourceClass.clockSkewSeconds ?? policy.clockSkewSeconds ?? 0,
      "clockSkewSeconds",
    ) * 1_000;
    if (!Number.isSafeInteger(clockSkewMillis)) {
      throw new Error("clockSkewSeconds exceeds safe time range");
    }
    addCadence(evaluationMillis, cadence);
    if (Math.abs(evaluationMillis - trustedNowMillis) > clockSkewMillis) {
      return { failure: extensionFailure("INELIGIBLE", "EVALUATION_TIME_INVALID") };
    }
    return { cadence, clockSkewMillis };
  } catch {
    return { failure: extensionFailure("INELIGIBLE", "POLICY_SCHEMA_INVALID") };
  }
}

function exactSourceClass(policy, sourceClassId) {
  const matchingClasses = Array.isArray(policy.sourceClasses)
    ? policy.sourceClasses.filter((entry) => isRecord(entry) && entry.id === sourceClassId)
    : [];
  return matchingClasses.length === 1 && Array.isArray(matchingClasses[0].sourceIds)
    ? matchingClasses[0]
    : null;
}

function evaluateExtensionObservation({ input, context, timeline, policyResolution }) {
  const observation = input.observation;
  if (observation == null) {
    return extensionResult(context, "NO_EXTENSION", "OBSERVATION_MISSING");
  }
  if (!validObservation(observation)) {
    return extensionResult(context, "INELIGIBLE", "OBSERVATION_SCHEMA_INVALID");
  }
  context.observationEvidenceSha256 = observation.evidenceSha256;
  if (!sameObservationIdentity(observation, input.sourceIdentity)) {
    return extensionResult(context, "INELIGIBLE", "SOURCE_IDENTITY_MISMATCH");
  }

  const timing = resolveObservationTiming(observation, timeline.evaluationMillis, policyResolution);
  if (timing.failure) return resultFromFailure(context, timing.failure);
  context.observedAt = new Date(timing.observedMillis).toISOString();

  const bounds = resolveObservationBounds(observation, timing.observedMillis);
  if (bounds.failure) return resultFromFailure(context, bounds.failure);
  if (observation.outcome !== "POSITIVE") {
    return extensionResult(context, "NO_EXTENSION", `OBSERVATION_${observation.outcome}`);
  }
  return positiveExtensionResult(context, timeline, timing.policyCandidateMillis, bounds.values);
}

function sameObservationIdentity(observation, sourceIdentity) {
  return SOURCE_IDENTITY_KEYS
    .filter((key) => key !== "currentFreshUntil")
    .every((key) => observation[key] === sourceIdentity[key]);
}

function resolveObservationTiming(observation, evaluationMillis, { cadence, clockSkewMillis }) {
  let observedMillis;
  try {
    observedMillis = requiredUtcInstant(observation.observedAt, "observation.observedAt");
  } catch {
    return { failure: extensionFailure("INELIGIBLE", "OBSERVATION_SCHEMA_INVALID") };
  }
  if (observedMillis > evaluationMillis + clockSkewMillis) {
    return { failure: extensionFailure("INELIGIBLE", "OBSERVATION_IN_FUTURE") };
  }

  let policyCandidateMillis;
  try {
    policyCandidateMillis = addCadence(observedMillis, cadence);
  } catch {
    return { failure: extensionFailure("INELIGIBLE", "POLICY_SCHEMA_INVALID") };
  }
  return policyCandidateMillis <= evaluationMillis
    ? { failure: extensionFailure("INELIGIBLE", "OBSERVATION_STALE") }
    : { observedMillis, policyCandidateMillis };
}

function resolveObservationBounds(observation, observedMillis) {
  const values = [];
  for (const key of ["providerValidUntil", "sourceValidUntil", "licenseValidUntil"]) {
    if (observation[key] == null) continue;
    let value;
    try {
      value = requiredUtcInstant(observation[key], `observation.${key}`);
    } catch {
      return { failure: extensionFailure("INELIGIBLE", "OBSERVATION_BOUND_INVALID") };
    }
    if (value <= observedMillis) {
      return { failure: extensionFailure("INELIGIBLE", "OBSERVATION_BOUND_INVALID") };
    }
    values.push(value);
  }
  return { values };
}

function positiveExtensionResult(context, timeline, policyCandidateMillis, bounds) {
  const candidateMillis = Math.min(policyCandidateMillis, ...bounds);
  if (candidateMillis <= timeline.evaluationMillis) {
    return extensionResult(context, "NO_EXTENSION", "EXTENSION_BOUND_EXHAUSTED");
  }
  if (candidateMillis <= timeline.currentFreshUntilMillis) {
    return extensionResult(context, "NO_EXTENSION", "EXTENSION_NOT_MONOTONIC");
  }
  context.extendedFreshUntil = new Date(candidateMillis).toISOString();
  return extensionResult(context, "EXTENDED", "POSITIVE_OBSERVATION_EXTENDED");
}

function extensionFailure(decisionValue, reasonCode) {
  return { decision: decisionValue, reasonCode };
}

function resultFromFailure(context, failure) {
  return extensionResult(context, failure.decision, failure.reasonCode);
}

function extensionResultContext(input) {
  const identity = isRecord(input?.sourceIdentity) ? input.sourceIdentity : {};
  const policyBinding = isRecord(input?.policyBinding) ? input.policyBinding : {};
  const observation = isRecord(input?.observation) ? input.observation : {};
  return {
    sourceId: safeString(identity.sourceId),
    snapshotId: safeString(identity.snapshotId),
    snapshotSha256: safeSha256(identity.snapshotSha256),
    rawEvidenceSha256: safeSha256(identity.rawEvidenceSha256),
    sourceClassId: safeString(policyBinding.sourceClassId),
    policySha256: safeSha256(policyBinding.policySha256),
    observationEvidenceSha256: safeSha256(observation.evidenceSha256),
    currentFreshUntil: null,
    extendedFreshUntil: null,
    evaluatedAt: null,
    observedAt: null,
  };
}

function extensionResult(context, decisionValue, reasonCode) {
  const unsigned = {
    schemaVersion: 1,
    artifactKind: "source-freshness-extension-result",
    decision: decisionValue,
    reasonCode,
    sourceId: context.sourceId,
    snapshotId: context.snapshotId,
    snapshotSha256: context.snapshotSha256,
    rawEvidenceSha256: context.rawEvidenceSha256,
    sourceClassId: context.sourceClassId,
    policySha256: context.policySha256,
    observationEvidenceSha256: context.observationEvidenceSha256,
    currentFreshUntil: context.currentFreshUntil,
    extendedFreshUntil: context.extendedFreshUntil,
    evaluatedAt: context.evaluatedAt,
    observedAt: context.observedAt,
  };
  return {
    ...unsigned,
    resultSha256: sha256(Buffer.from(canonicalJson(unsigned), "utf8")),
  };
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function safeString(value) {
  return nonEmptyString(value) ? value : null;
}

function safeSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : null;
}

function decision(outcome, productionWriteAllowed) {
  return { outcome, productionWriteAllowed };
}
