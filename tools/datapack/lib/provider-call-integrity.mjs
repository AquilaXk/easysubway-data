// #22: provider 호출 정합성 계약.
// 같은 응답 코드가 "키 훼손"과 "권한 미보유" 모두에서 돌아오기 때문에, 응답만 보고 외부 blocker로
// 굳히는 것을 구조적으로 막는다. 세 가지를 강제한다.
//   1) 키 형상 사전 검사 — 카탈로그에는 키 값이 아니라 길이·문자 클래스·복원 불가 지문만 둔다.
//   2) 대조군 강제 — 권한 미보유 판정은 같은 실행·같은 키의 대조군 성공을 전제조건으로 요구한다.
//   3) 실패 분류 — 모든 provider 실패를 5개 값으로 분류하고 근거(HTTP status, result code, 대조군)를 남긴다.
import { createHash } from "node:crypto";

const CREDENTIAL_FINGERPRINT_LABEL = "easysubway-data:provider-credential:v1";
const CREDENTIAL_FINGERPRINT_ALGORITHM = "sha256-12";
const CREDENTIAL_FINGERPRINT_LENGTH = 12;
const CREDENTIAL_CHARACTER_CLASSES = Object.freeze(["digit", "lower", "symbol", "upper"]);
const REDACTED_SERVICE_KEY = "[서비스키값]";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
// source-operation.mjs의 CREDENTIAL_NAME과 같은 목록. 공개 저장소에 라이브 키가 커밋되는 경로를 닫는다.
const CREDENTIAL_PARAMETER_NAME = /^(?:accesskey|accesstoken|apikey|authorization|clientsecret|credential|key|password|privatekey|refreshtoken|secret|servicekey|signature|token|xamzcredential|xamzsecuritytoken|xamzsignature|xapikey)$/;

export const PROVIDER_FAILURE_CLASSIFICATIONS = Object.freeze([
  "request-error",
  "authentication-error",
  "authorization-missing",
  "no-data",
  "transport-error",
]);

export const CONTROL_OPERATION_STATUSES = Object.freeze(["succeeded", "failed", "not-run"]);

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireAllowedKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}`);
}

function credentialCharacterClass(character) {
  if (character >= "A" && character <= "Z") return "upper";
  if (character >= "a" && character <= "z") return "lower";
  if (character >= "0" && character <= "9") return "digit";
  if (character >= "!" && character <= "~") return "symbol";
  return null;
}

export function providerCredentialShape(credential) {
  requiredText(credential, "provider credential");
  const characterClasses = new Set();
  for (const character of credential) {
    const name = credentialCharacterClass(character);
    if (name == null) {
      throw new Error("provider credential contains a character outside the printable ASCII contract");
    }
    characterClasses.add(name);
  }
  return {
    length: credential.length,
    characterClasses: CREDENTIAL_CHARACTER_CLASSES.filter((name) => characterClasses.has(name)),
    fingerprint: createHash("sha256")
      .update(`${CREDENTIAL_FINGERPRINT_LABEL}:${credential}`)
      .digest("hex")
      .slice(0, CREDENTIAL_FINGERPRINT_LENGTH),
  };
}

export function validateProviderCredentialContract(providerId, contract) {
  const label = `${providerId}.credential`;
  requireObject(contract, label);
  requireAllowedKeys(
    contract,
    new Set(["env", "length", "characterClasses", "fingerprintAlgorithm", "fingerprint"]),
    label,
  );
  if (!/^[A-Z][A-Z0-9_]*$/.test(requiredText(contract.env, `${label}.env`))) {
    throw new Error(`${label}.env must be an environment variable name`);
  }
  if (!Number.isInteger(contract.length) || contract.length < 1) {
    throw new Error(`${label}.length must be a positive integer`);
  }
  const characterClasses = contract.characterClasses;
  if (!Array.isArray(characterClasses) || characterClasses.length === 0
    || characterClasses.some((name) => !CREDENTIAL_CHARACTER_CLASSES.includes(name))) {
    throw new Error(`${label}.characterClasses must list printable ASCII character classes`);
  }
  const sorted = CREDENTIAL_CHARACTER_CLASSES.filter((name) => characterClasses.includes(name));
  if (characterClasses.join(",") !== sorted.join(",")) {
    throw new Error(`${label}.characterClasses must be sorted and free of duplicates`);
  }
  if (contract.fingerprintAlgorithm !== CREDENTIAL_FINGERPRINT_ALGORITHM) {
    throw new Error(`${label}.fingerprintAlgorithm must be ${CREDENTIAL_FINGERPRINT_ALGORITHM}`);
  }
  if (!Object.hasOwn(contract, "fingerprint")
    || (contract.fingerprint !== null && !/^[0-9a-f]{12}$/.test(contract.fingerprint))) {
    throw new Error(`${label}.fingerprint must be a 12 character hex fingerprint or null`);
  }
  return contract;
}

// 카탈로그 계약과 어긋나면 provider를 호출하기 전에 멈춘다. 오류 문구에는 키 값도, 실측 형상도 남기지 않는다.
export function assertProviderCredentialIntegrity({ providerId, credential, contract } = {}) {
  const label = `${providerId} credential`;
  validateProviderCredentialContract(providerId, contract);
  let shape;
  try {
    shape = providerCredentialShape(credential);
  } catch (error) {
    throw new Error(`${label} shape is invalid: ${error instanceof Error ? error.message : "unknown"}`);
  }
  if (shape.length !== contract.length) {
    throw new Error(`${label} length does not match the catalog contract (expected ${contract.length})`);
  }
  if (shape.characterClasses.join(",") !== contract.characterClasses.join(",")) {
    throw new Error(`${label} character classes do not match the catalog contract (expected ${contract.characterClasses.join(",")})`);
  }
  if (contract.fingerprint != null && shape.fingerprint !== contract.fingerprint) {
    throw new Error(`${label} fingerprint does not match the catalog contract (expected ${contract.fingerprint})`);
  }
  return {
    length: shape.length,
    characterClasses: shape.characterClasses,
    fingerprintPinned: contract.fingerprint != null,
  };
}

// 자격증명성 query 파라미터는 endpoint에서 전면 거부하고, sampleUrl에서는 정확한 redaction 자리표시자만 허용한다.
function credentialFreeProviderUrl(value, label, { allowRedactedCredential = false } = {}) {
  let url;
  try {
    url = new URL(requiredText(value, label));
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  for (const [name, parameterValue] of url.searchParams) {
    if (!CREDENTIAL_PARAMETER_NAME.test(name.replace(/[^A-Za-z0-9]/g, "").toLowerCase())) continue;
    if (allowRedactedCredential && parameterValue === REDACTED_SERVICE_KEY) continue;
    throw new Error(`${label} must not carry a credential query parameter: ${name}`);
  }
  return url;
}

function validateExpectedControlSuccess(label, expectedSuccess) {
  requireObject(expectedSuccess, label);
  requireAllowedKeys(expectedSuccess, new Set(["minimumRowCount", "requiredFields"]), label);
  if (!Number.isInteger(expectedSuccess.minimumRowCount) || expectedSuccess.minimumRowCount < 1) {
    throw new Error(`${label}.minimumRowCount must be a positive integer`);
  }
  const requiredFields = expectedSuccess.requiredFields;
  if (!Array.isArray(requiredFields) || requiredFields.length === 0
    || requiredFields.some((field) => typeof field !== "string" || !PROVIDER_FIELD_NAME.test(field))
    || new Set(requiredFields).size !== requiredFields.length
    || requiredFields.join(",") !== [...requiredFields].sort().join(",")) {
    throw new Error(`${label}.requiredFields must be a sorted non-empty provider field name array`);
  }
  return { minimumRowCount: expectedSuccess.minimumRowCount, requiredFields: [...requiredFields] };
}

export function validateProviderControlOperation(providerId, controlOperation) {
  const label = `${providerId}.controlOperation`;
  requireObject(controlOperation, label);
  requireAllowedKeys(
    controlOperation,
    new Set(["candidateId", "endpoint", "sampleUrl", "expectedSuccess", "verifiedAt"]),
    label,
  );
  const candidateId = requiredText(controlOperation.candidateId, `${label}.candidateId`);
  const endpoint = credentialFreeProviderUrl(controlOperation.endpoint, `${label}.endpoint`);
  const sampleUrl = credentialFreeProviderUrl(controlOperation.sampleUrl, `${label}.sampleUrl`, {
    allowRedactedCredential: true,
  });
  if (sampleUrl.origin !== endpoint.origin || sampleUrl.pathname !== endpoint.pathname) {
    throw new Error(`${label}.sampleUrl must use the control operation endpoint`);
  }
  const serviceKeys = [...sampleUrl.searchParams.entries()].filter(([name]) => name.toLowerCase() === "servicekey");
  if (serviceKeys.length !== 1 || serviceKeys[0][0] !== "serviceKey" || serviceKeys[0][1] !== REDACTED_SERVICE_KEY) {
    throw new Error(`${label}.sampleUrl must contain exactly one redacted serviceKey`);
  }
  const format = requiredText(sampleUrl.searchParams.get("format"), `${label}.sampleUrl format`).toLowerCase();
  if (!new Set(["json", "xml"]).has(format)) {
    throw new Error(`${label}.sampleUrl format is not supported: ${format}`);
  }
  const expectedSuccess = validateExpectedControlSuccess(
    `${label}.expectedSuccess`,
    controlOperation.expectedSuccess,
  );
  if (!ISO_DATE.test(requiredText(controlOperation.verifiedAt, `${label}.verifiedAt`))) {
    throw new Error(`${label}.verifiedAt must be an ISO date`);
  }
  return {
    candidateId,
    endpoint: endpoint.href,
    expectedSuccess,
    format,
    sampleUrl: controlOperation.sampleUrl,
    verifiedAt: controlOperation.verifiedAt,
  };
}

export function resolveProviderCallIntegrity(document, providerId, { required = true } = {}) {
  const provider = document?.providers?.[providerId];
  if (provider == null) {
    if (!required) return null;
    throw new Error(`provider call integrity contract is missing: ${providerId}`);
  }
  requireObject(provider, `${providerId} provider contract`);
  requireAllowedKeys(provider, new Set(["credential", "controlOperation"]), `${providerId} provider contract`);
  return {
    credential: validateProviderCredentialContract(providerId, provider.credential),
    controlOperation: validateProviderControlOperation(providerId, provider.controlOperation),
  };
}

// 키 훼손과 권한 미보유가 같은 신호로 돌아오는 구간. 대조군 없이는 어느 쪽으로도 판정하지 않는다.
export function requiresControlOperation({ httpStatus = null, providerResultSignal = null } = {}) {
  return providerResultSignal === "authorization" || httpStatus === 401 || httpStatus === 403;
}

export function classifyProviderFailure({
  httpStatus = null,
  providerResultCode = null,
  providerResultSignal = null,
  controlOperationStatus = "not-run",
} = {}) {
  if (!CONTROL_OPERATION_STATUSES.includes(controlOperationStatus)) {
    throw new Error(`provider control operation status is invalid: ${controlOperationStatus}`);
  }
  const diagnosis = { controlOperationStatus, httpStatus, providerResultCode, providerResultSignal };
  if (httpStatus == null) {
    return { classification: "transport-error", ...diagnosis };
  }
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new Error("provider HTTP status is invalid");
  }
  if (httpStatus >= 500) {
    return { classification: "transport-error", ...diagnosis };
  }
  if (requiresControlOperation({ httpStatus, providerResultSignal })) {
    if (controlOperationStatus === "not-run") {
      throw new Error("provider credential signal requires a same-run control operation result");
    }
    return {
      classification: controlOperationStatus === "succeeded" ? "authorization-missing" : "authentication-error",
      ...diagnosis,
    };
  }
  if (providerResultSignal === "no-data") {
    return { classification: "no-data", ...diagnosis };
  }
  // 나머지(파라미터 오류, HTTP 4xx, 우리 쪽 파싱 실패)는 provider 인증·권한·데이터 문제가 아니므로
  // blocker 승격 자격이 없는 요청오류로 닫는다.
  return { classification: "request-error", ...diagnosis };
}

export function formatProviderFailureEvidence(diagnosis) {
  return `failureClass=${diagnosis.classification} controlOperation=${diagnosis.controlOperationStatus}`;
}

export function assertProviderBlockerPromotable(diagnosis) {
  if (diagnosis?.classification !== "authorization-missing") {
    throw new Error("provider blocker promotion requires the authorization-missing classification");
  }
  if (diagnosis.controlOperationStatus !== "succeeded") {
    throw new Error("provider blocker promotion requires a succeeded control operation");
  }
  if (diagnosis.httpStatus == null || diagnosis.providerResultCode == null) {
    throw new Error("provider blocker promotion requires HTTP status and provider result code evidence");
  }
  return diagnosis;
}
