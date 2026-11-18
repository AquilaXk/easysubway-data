const requiredKeys = ["defaultDailyLimit", "portal", "productionUseAllowed", "unlockStatus"];
const optionalKeys = ["documentedMonthlyLimit", "runtimeDailyHardLimit", "runtimePerMinuteHardLimit", "sharedQuotaStore"];

export function validateQuotaEvidence(quotaEvidence, label) {
  if (!quotaEvidence || typeof quotaEvidence !== "object" || Array.isArray(quotaEvidence)) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(quotaEvidence);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  if (!requiredKeys.every((key) => keys.includes(key)) || keys.some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} must include ${requiredKeys.join(", ")} and only optional ${optionalKeys.join(", ")}`);
  }
  requiredText(quotaEvidence.portal, `${label}.portal`);
  if (
    quotaEvidence.defaultDailyLimit !== null &&
    quotaEvidence.defaultDailyLimit !== "unlimited" &&
    (!Number.isInteger(quotaEvidence.defaultDailyLimit) || quotaEvidence.defaultDailyLimit < 0)
  ) {
    throw new Error(`${label}.defaultDailyLimit must be null, a non-negative integer, or unlimited`);
  }
  if (
    "documentedMonthlyLimit" in quotaEvidence &&
    (!Number.isInteger(quotaEvidence.documentedMonthlyLimit) || quotaEvidence.documentedMonthlyLimit <= 0)
  ) {
    throw new Error(`${label}.documentedMonthlyLimit must be a positive integer`);
  }
  for (const key of ["runtimeDailyHardLimit", "runtimePerMinuteHardLimit"]) {
    if (key in quotaEvidence && !Number.isInteger(quotaEvidence[key])) {
      throw new TypeError(`${label}.${key} must be an integer`);
    }
    if (key in quotaEvidence && quotaEvidence[key] <= 0) {
      throw new Error(`${label}.${key} must be a positive integer`);
    }
  }
  const hasRuntimeDailyHardLimit = "runtimeDailyHardLimit" in quotaEvidence;
  const hasRuntimePerMinuteHardLimit = "runtimePerMinuteHardLimit" in quotaEvidence;
  if (hasRuntimeDailyHardLimit !== hasRuntimePerMinuteHardLimit) {
    throw new Error(`${label} must include runtimeDailyHardLimit and runtimePerMinuteHardLimit together`);
  }
  if ("sharedQuotaStore" in quotaEvidence) {
    requiredText(quotaEvidence.sharedQuotaStore, `${label}.sharedQuotaStore`);
    if (!hasRuntimeDailyHardLimit || !hasRuntimePerMinuteHardLimit) {
      throw new Error(`${label}.sharedQuotaStore requires runtimeDailyHardLimit and runtimePerMinuteHardLimit`);
    }
  }
  if (
    Number.isInteger(quotaEvidence.defaultDailyLimit) &&
    Number.isInteger(quotaEvidence.runtimeDailyHardLimit) &&
    quotaEvidence.runtimeDailyHardLimit > quotaEvidence.defaultDailyLimit
  ) {
    throw new Error(`${label}.runtimeDailyHardLimit must not exceed defaultDailyLimit`);
  }
  if (quotaEvidence.defaultDailyLimit === null && !("documentedMonthlyLimit" in quotaEvidence)) {
    throw new Error(`${label}.defaultDailyLimit null requires documentedMonthlyLimit`);
  }
  requiredText(quotaEvidence.unlockStatus, `${label}.unlockStatus`);
  if (typeof quotaEvidence.productionUseAllowed !== "boolean") {
    throw new TypeError(`${label}.productionUseAllowed must be a boolean`);
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
