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

export function evaluateFreshnessExtension({ input, policy } = {}) {
  const context = extensionResultContext(input);
  if (!validExtensionInputEnvelope(input)) {
    return extensionResult(context, "INELIGIBLE", "INPUT_SCHEMA_INVALID");
  }

  let evaluationMillis;
  let currentFreshUntilMillis;
  try {
    evaluationMillis = requiredUtcInstant(input.evaluationAt, "evaluationAt");
    currentFreshUntilMillis = requiredUtcInstant(
      input.sourceIdentity.currentFreshUntil,
      "sourceIdentity.currentFreshUntil",
    );
  } catch {
    return extensionResult(context, "INELIGIBLE", "INPUT_SCHEMA_INVALID");
  }
  context.evaluatedAt = new Date(evaluationMillis).toISOString();
  context.currentFreshUntil = new Date(currentFreshUntilMillis).toISOString();

  if (!isRecord(policy)) {
    return extensionResult(context, "INELIGIBLE", "POLICY_SCHEMA_INVALID");
  }
  let actualPolicySha256;
  try {
    actualPolicySha256 = freshnessPolicySha256(policy);
  } catch {
    return extensionResult(context, "INELIGIBLE", "POLICY_SCHEMA_INVALID");
  }
  if (input.policyBinding.policySha256 !== actualPolicySha256) {
    return extensionResult(context, "INELIGIBLE", "POLICY_IDENTITY_MISMATCH");
  }

  const matchingClasses = Array.isArray(policy.sourceClasses)
    ? policy.sourceClasses.filter((entry) => (
      isRecord(entry) && entry.id === input.policyBinding.sourceClassId
    ))
    : [];
  if (matchingClasses.length !== 1
    || !Array.isArray(matchingClasses[0].sourceIds)
    || !matchingClasses[0].sourceIds.includes(input.sourceIdentity.sourceId)) {
    return extensionResult(context, "INELIGIBLE", "SOURCE_CLASS_INELIGIBLE");
  }
  const sourceClass = matchingClasses[0];
  const cadence = sourceClass.reverificationCadence ?? sourceClass.maximumReverificationCadence;
  let clockSkewMillis;
  try {
    clockSkewMillis = requiredNonNegativeInteger(
      sourceClass.clockSkewSeconds ?? policy.clockSkewSeconds ?? 0,
      "clockSkewSeconds",
    ) * 1_000;
    addCadence(evaluationMillis, cadence);
  } catch {
    return extensionResult(context, "INELIGIBLE", "POLICY_SCHEMA_INVALID");
  }

  if (input.observation == null) {
    return extensionResult(context, "NO_EXTENSION", "OBSERVATION_MISSING");
  }
  if (!validObservation(input.observation)) {
    return extensionResult(context, "INELIGIBLE", "OBSERVATION_SCHEMA_INVALID");
  }
  const observation = input.observation;
  context.observationEvidenceSha256 = observation.evidenceSha256;

  if (SOURCE_IDENTITY_KEYS.filter((key) => key !== "currentFreshUntil").some((key) => (
    observation[key] !== input.sourceIdentity[key]
  ))) {
    return extensionResult(context, "INELIGIBLE", "SOURCE_IDENTITY_MISMATCH");
  }

  let observedMillis;
  try {
    observedMillis = requiredUtcInstant(observation.observedAt, "observation.observedAt");
  } catch {
    return extensionResult(context, "INELIGIBLE", "OBSERVATION_SCHEMA_INVALID");
  }
  context.observedAt = new Date(observedMillis).toISOString();
  if (observedMillis > evaluationMillis + clockSkewMillis) {
    return extensionResult(context, "INELIGIBLE", "OBSERVATION_IN_FUTURE");
  }

  let policyCandidateMillis;
  try {
    policyCandidateMillis = addCadence(observedMillis, cadence);
  } catch {
    return extensionResult(context, "INELIGIBLE", "POLICY_SCHEMA_INVALID");
  }
  if (policyCandidateMillis <= evaluationMillis) {
    return extensionResult(context, "INELIGIBLE", "OBSERVATION_STALE");
  }

  const boundMillis = [];
  for (const key of ["providerValidUntil", "sourceValidUntil", "licenseValidUntil"]) {
    if (observation[key] == null) continue;
    let value;
    try {
      value = requiredUtcInstant(observation[key], `observation.${key}`);
    } catch {
      return extensionResult(context, "INELIGIBLE", "OBSERVATION_BOUND_INVALID");
    }
    if (value <= observedMillis) {
      return extensionResult(context, "INELIGIBLE", "OBSERVATION_BOUND_INVALID");
    }
    boundMillis.push(value);
  }

  if (observation.outcome !== "POSITIVE") {
    return extensionResult(
      context,
      "NO_EXTENSION",
      `OBSERVATION_${observation.outcome}`,
    );
  }

  const candidateMillis = Math.min(policyCandidateMillis, ...boundMillis);
  if (candidateMillis <= evaluationMillis) {
    return extensionResult(context, "NO_EXTENSION", "EXTENSION_BOUND_EXHAUSTED");
  }
  if (candidateMillis <= currentFreshUntilMillis) {
    return extensionResult(context, "NO_EXTENSION", "EXTENSION_NOT_MONOTONIC");
  }
  context.extendedFreshUntil = new Date(candidateMillis).toISOString();
  return extensionResult(context, "EXTENDED", "POSITIVE_OBSERVATION_EXTENDED");
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
  return isRecord(value)
    && Object.keys(value).toSorted().join("\u0000") === keys.toSorted().join("\u0000");
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
