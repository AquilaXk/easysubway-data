const requiredKeys = ["defaultDailyLimit", "portal", "productionUseAllowed", "unlockStatus"];
const optionalKeys = ["documentedMonthlyLimit"];

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
