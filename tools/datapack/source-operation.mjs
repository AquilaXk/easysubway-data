#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CANDIDATES_URL = new URL("./source-candidates.json", import.meta.url);
const CREDENTIAL_NAME = /^(?:accesskey|accesstoken|apikey|authorization|clientsecret|credential|key|password|privatekey|refreshtoken|secret|servicekey|signature|token|xamzcredential|xamzsecuritytoken|xamzsignature|xapikey)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizedName(value) {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isPlaceholder(value) {
  return /^(?:\[[^\]]+\]|\{[^}]+\}|\$\{[^}]+\})$/.test(value);
}

function requiredHttpUrl(value, label) {
  const text = requiredText(value, label);
  try {
    const url = new URL(text);
    if (!new Set(["http:", "https:"]).has(url.protocol) || !url.hostname) throw new Error();
    return url;
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
}

function hasConcretePathCredential(templateUrl, sampleUrl) {
  const templateSegments = templateUrl.pathname.split("/").map(decodeURIComponent);
  const sampleSegments = sampleUrl.pathname.split("/").map(decodeURIComponent);
  return templateSegments.some((segment, index) => {
    const match = /^\{([^}]+)\}$/.exec(segment);
    return match && CREDENTIAL_NAME.test(normalizedName(match[1]))
      && !isPlaceholder(sampleSegments[index] ?? "");
  });
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function stringList(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be a${allowEmpty ? "" : " non-empty"} string array`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return value;
}

function hasCredentialValue(value) {
  if (Array.isArray(value)) return value.some(hasCredentialValue);
  if (typeof value === "string") {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Non-URL strings are checked by the other credential patterns.
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(decoded)) return true;
    if (/\b(?:Basic|Bearer)\s+(?!\[|\{|env:)[A-Za-z0-9._~+/=-]+/i.test(decoded)) return true;
    try {
      const url = new URL(decoded);
      if (url.username || url.password) return true;
      for (const [key, child] of url.searchParams) {
        if (CREDENTIAL_NAME.test(normalizedName(key)) && !isPlaceholder(child)) return true;
      }
    } catch {
      // Not every operation string is a URL.
    }
    return [...decoded.matchAll(/[?&](?:(?:access|api|private|service)[_-]?key|client[_-]?secret|password|refresh[_-]?token|secret|token)=([^&#]*)/gi)]
      .some((match) => !isPlaceholder(match[1]));
  }
  if (value == null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    CREDENTIAL_NAME.test(normalizedName(key).replace(/value$/, "")) ||
    hasCredentialValue(child),
  );
}

function requireAllowedKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}`);
}

function requiredDate(value, label) {
  const text = requiredText(value, label);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!ISO_DATE.test(text) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label} must be an ISO date`);
  }
  return text;
}

export function validateProviderApproval(candidate, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const approval = candidate?.providerApproval;
  if (approval == null) return null;
  if (typeof approval !== "object" || Array.isArray(approval)) {
    throw new Error(`${candidate.id}.providerApproval must be an object`);
  }
  if (hasCredentialValue(approval)) {
    throw new Error(`${candidate.id}.providerApproval secret-like values are forbidden`);
  }
  requireAllowedKeys(approval, new Set([
    "status", "approvalScope", "termsStatus", "quotaStatus", "productionUseAllowed",
    "serviceId", "operationId", "validFrom", "validTo", "renewalNoticeDays", "evidenceReferences", "recordedAt",
  ]), `${candidate.id}.providerApproval`);
  if (!new Set(["APPROVED", "EXPIRED", "REVOKED"]).has(approval.status)) {
    throw new Error(`${candidate.id}.providerApproval.status is invalid`);
  }
  if (approval.approvalScope !== "API_CREDENTIAL") {
    throw new Error(`${candidate.id}.providerApproval.approvalScope must be API_CREDENTIAL`);
  }
  const conditionStatuses = new Set(["APPROVED", "REVIEW_REQUIRED", "REJECTED", "NOT_APPLICABLE"]);
  for (const field of ["termsStatus", "quotaStatus"]) {
    if (!conditionStatuses.has(approval[field])) {
      throw new Error(`${candidate.id}.providerApproval.${field} is invalid`);
    }
  }
  if (typeof approval.productionUseAllowed !== "boolean") {
    throw new Error(`${candidate.id}.providerApproval.productionUseAllowed must be a boolean`);
  }
  const productionUseAllowed = approval.status === "APPROVED"
    && [approval.termsStatus, approval.quotaStatus].every((status) => new Set(["APPROVED", "NOT_APPLICABLE"]).has(status));
  if (approval.productionUseAllowed !== productionUseAllowed) {
    throw new Error(`${candidate.id}.providerApproval.productionUseAllowed must match credential, terms, and quota decisions`);
  }
  const serviceId = requiredText(approval.serviceId, `${candidate.id}.providerApproval.serviceId`);
  const operationId = requiredText(approval.operationId, `${candidate.id}.providerApproval.operationId`);
  if (candidate.operation?.endpoint != null) {
    const endpoint = requiredHttpUrl(candidate.operation.endpoint, `${candidate.id}.operation.endpoint`);
    const path = endpoint.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (path.at(-2) !== serviceId || path.at(-1) !== operationId) {
      throw new Error(`${candidate.id}.providerApproval serviceId/operationId must match operation endpoint path`);
    }
  }
  const validFrom = requiredDate(approval.validFrom, `${candidate.id}.providerApproval.validFrom`);
  const validTo = requiredDate(approval.validTo, `${candidate.id}.providerApproval.validTo`);
  if (approval.renewalNoticeDays != null
    && (!Number.isInteger(approval.renewalNoticeDays) || approval.renewalNoticeDays < 1)) {
    throw new Error(`${candidate.id}.providerApproval.renewalNoticeDays must be a positive integer`);
  }
  if (validTo < validFrom) {
    throw new Error(`${candidate.id}.providerApproval.validTo must not precede validFrom`);
  }
  if (!Array.isArray(approval.evidenceReferences) || approval.evidenceReferences.length === 0) {
    throw new Error(`${candidate.id}.providerApproval.evidenceReferences must be a non-empty array`);
  }
  const evidenceUrls = new Set();
  for (const [index, evidence] of approval.evidenceReferences.entries()) {
    if (evidence == null || typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new Error(`${candidate.id}.providerApproval.evidenceReferences[${index}] must be an object`);
    }
    requireAllowedKeys(evidence, new Set(["type", "url"]), `${candidate.id}.providerApproval.evidenceReferences[${index}]`);
    if (!new Set(["OWNER_CONFIRMATION", "PROVIDER_PORTAL", "PROVIDER_DOCUMENT"]).has(evidence.type)) {
      throw new Error(`${candidate.id}.providerApproval.evidenceReferences[${index}].type is invalid`);
    }
    const url = requiredHttpUrl(evidence.url, `${candidate.id}.providerApproval.evidenceReferences[${index}].url`).href;
    if (evidenceUrls.has(url)) {
      throw new Error(`${candidate.id}.providerApproval.evidenceReferences must not contain duplicate URLs`);
    }
    evidenceUrls.add(url);
  }
  requiredDate(approval.recordedAt, `${candidate.id}.providerApproval.recordedAt`);
  requiredDate(today, "provider approval current date");
  if (approval.status === "APPROVED" && validTo < today) {
    throw new Error(`${candidate.id}.providerApproval.status is APPROVED but validTo has expired`);
  }
  if (approval.status === "APPROVED" && validFrom > today) {
    throw new Error(`${candidate.id}.providerApproval.status is APPROVED but validFrom is in the future`);
  }
  return approval;
}

export function validateSourceCandidateDocument(document, options = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("source candidate document must be an object");
  }
  if (document.schemaVersion !== 1 || document.artifactKind !== "production-source-candidates") {
    throw new Error("source candidate document identity is invalid");
  }
  if (document.source !== "tools/datapack/source-candidates.json") {
    throw new Error("source candidate document source must be repository-local");
  }
  requiredDate(document.updatedAt, "source candidate document.updatedAt");
  if (!Array.isArray(document.candidates)) throw new Error("source candidate document.candidates must be an array");
  const ids = new Set();
  for (const candidate of document.candidates) {
    const id = requiredText(candidate?.id, "candidate.id");
    if (ids.has(id)) throw new Error(`duplicate candidate id: ${id}`);
    ids.add(id);
    validateProviderApproval(candidate, options);
  }
  return document;
}

export function providerApprovalExpirySummary(document, { today = new Date().toISOString().slice(0, 10) } = {}) {
  validateSourceCandidateDocument(document, { today });
  const todayMillis = Date.parse(`${today}T00:00:00Z`);
  const approvals = document.candidates
    .filter((candidate) => candidate.providerApproval?.status === "APPROVED")
    .map((candidate) => {
      const approval = candidate.providerApproval;
      return {
        candidateId: candidate.id,
        validTo: approval.validTo,
        daysUntilExpiry: Math.floor((Date.parse(`${approval.validTo}T00:00:00Z`) - todayMillis) / 86_400_000),
        renewalNoticeDays: approval.renewalNoticeDays ?? 30,
      };
    });
  return {
    status: approvals.some((approval) => approval.daysUntilExpiry <= approval.renewalNoticeDays)
      ? "WARNING"
      : "OK",
    approvals,
  };
}

export function validateOperation(candidate, { allowMissing = false } = {}) {
  const requestUrl = requiredHttpUrl(candidate?.requestUrl, `${candidate?.id ?? "candidate"}.requestUrl`);
  if (hasCredentialValue(candidate.requestUrl)) {
    throw new Error(`${candidate.id}.requestUrl credential values are forbidden`);
  }
  const sampleValue = candidate?.evidence?.sampleUrl;
  if (sampleValue != null) {
    const sampleUrl = requiredHttpUrl(sampleValue, `${candidate.id}.evidence.sampleUrl`);
    if (hasCredentialValue(sampleValue) || hasConcretePathCredential(requestUrl, sampleUrl)) {
      throw new Error(`${candidate.id}.evidence.sampleUrl credential values are forbidden`);
    }
  }
  const operation = candidate?.operation;
  if (operation == null) {
    if (allowMissing) return null;
    throw new Error(`${candidate?.id ?? "candidate"}.operation is required`);
  }
  if (typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error(`${candidate.id}.operation must be an object`);
  }
  if (hasCredentialValue(operation)) {
    throw new Error(`${candidate.id}.operation credential values are forbidden`);
  }
  requireAllowedKeys(operation, new Set([
    "method", "endpoint", "sampleUrl", "auth", "requiredParameters", "fixedParameters", "optionalParameters",
    "responseEnvelope", "responseFields", "runner", "secretPolicy",
  ]), `${candidate.id}.operation`);
  if (!new Set(["GET", "POST"]).has(operation.method)) {
    throw new Error(`${candidate.id}.operation.method must be GET or POST`);
  }
  const operationUrl = requiredHttpUrl(operation.endpoint, `${candidate.id}.operation.endpoint`);
  if (operationUrl.href !== requestUrl.href) {
    throw new Error(`${candidate.id}.operation endpoint must match requestUrl`);
  }
  if (operation.sampleUrl != null) {
    const operationSampleUrl = requiredHttpUrl(operation.sampleUrl, `${candidate.id}.operation.sampleUrl`);
    if (hasCredentialValue(operation.sampleUrl)
      || operationSampleUrl.origin !== operationUrl.origin
      || operationSampleUrl.pathname !== operationUrl.pathname) {
      throw new Error(`${candidate.id}.operation.sampleUrl must use the operation endpoint without credential values`);
    }
  }
  const auth = operation.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error(`${candidate.id}.operation.auth must be an object`);
  }
  if (!new Set(["query", "path", "header", "none"]).has(auth.placement)) {
    throw new Error(`${candidate.id}.operation.auth.placement is invalid`);
  }
  const credentialFree = auth.placement === "none";
  requireAllowedKeys(
    auth,
    credentialFree
      ? new Set(["placement"])
      : new Set(["env", "placement", "parameter", "valueEncoding", "loadPolicy"]),
    `${candidate.id}.operation.auth`,
  );
  const authEnv = credentialFree ? null : requiredText(auth.env, `${candidate.id}.operation.auth.env`);
  if (authEnv != null && !/^[A-Z][A-Z0-9_]*$/.test(authEnv)) {
    throw new Error(`${candidate.id}.operation.auth.env must be an environment variable name`);
  }
  const authParameter = credentialFree
    ? null
    : requiredText(auth.parameter, `${candidate.id}.operation.auth.parameter`);
  if (auth.valueEncoding != null && auth.valueEncoding !== "url-search-params-once") {
    throw new Error(`${candidate.id}.operation.auth.valueEncoding is invalid`);
  }
  if (auth.loadPolicy != null && auth.loadPolicy !== "process-env-no-shell-parsing") {
    throw new Error(`${candidate.id}.operation.auth.loadPolicy is invalid`);
  }
  const requiredParameters = stringList(
    operation.requiredParameters,
    `${candidate.id}.operation.requiredParameters`,
    { allowEmpty: true },
  );
  if (authParameter != null && !requiredParameters.includes(authParameter)) {
    throw new Error(`${candidate.id}.operation.requiredParameters must include the auth parameter`);
  }
  const fixedParameters = operation.fixedParameters ?? {};
  if (typeof fixedParameters !== "object" || Array.isArray(fixedParameters)) {
    throw new TypeError(`${candidate.id}.operation.fixedParameters must be an object`);
  }
  for (const [name, value] of Object.entries(fixedParameters)) {
    requiredText(name, `${candidate.id}.operation.fixedParameters name`);
    requiredText(value, `${candidate.id}.operation.fixedParameters.${name}`);
  }
  const optionalParameters = stringList(
    operation.optionalParameters ?? [],
    `${candidate.id}.operation.optionalParameters`,
    { allowEmpty: true },
  );
  const parameterNames = [
    ...requiredParameters,
    ...Object.keys(fixedParameters),
    ...optionalParameters,
  ];
  if (new Set(parameterNames).size !== parameterNames.length) {
    throw new Error(`${candidate.id}.operation parameter names must be disjoint`);
  }
  requiredText(operation.responseEnvelope, `${candidate.id}.operation.responseEnvelope`);
  if (operation.responseFields != null) {
    stringList(operation.responseFields, `${candidate.id}.operation.responseFields`);
  }
  const runner = operation.runner;
  if (!runner || typeof runner !== "object" || Array.isArray(runner)) {
    throw new Error(`${candidate.id}.operation.runner must be an object`);
  }
  requireAllowedKeys(runner, new Set(["command", "arguments", "requiredEnv"]), `${candidate.id}.operation.runner`);
  const command = requiredText(runner.command, `${candidate.id}.operation.runner.command`);
  if (!/^node tools\/[A-Za-z0-9_./-]+\.mjs$/.test(command)) {
    throw new Error(`${candidate.id}.operation.runner.command must be a literal repository Node command`);
  }
  const runnerArguments = stringList(
    runner.arguments ?? [],
    `${candidate.id}.operation.runner.arguments`,
    { allowEmpty: true },
  );
  if (runnerArguments.some((argument) => {
    const option = /^--([^=]+)(?:=|$)/.exec(argument);
    return option && CREDENTIAL_NAME.test(normalizedName(option[1]));
  })) {
    throw new Error(`${candidate.id}.operation.runner.arguments must not include credential options`);
  }
  const requiredEnv = stringList(
    runner.requiredEnv,
    `${candidate.id}.operation.runner.requiredEnv`,
    { allowEmpty: true },
  );
  if (requiredEnv.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error(`${candidate.id}.operation.runner.requiredEnv must contain environment variable names`);
  }
  if (authEnv != null && !requiredEnv.includes(authEnv)) {
    throw new Error(`${candidate.id}.operation.runner.requiredEnv must include auth.env`);
  }
  const expectedSecretPolicy = credentialFree ? "credential-free-output" : "env-only-redacted-output";
  if (operation.secretPolicy !== expectedSecretPolicy) {
    throw new Error(`${candidate.id}.operation.secretPolicy is invalid`);
  }
  return operation;
}

export function operationSummary(candidate) {
  if (candidate.apiCatalog != null && typeof candidate.apiCatalog !== "boolean") {
    throw new Error(`${candidate.id}.apiCatalog must be a boolean`);
  }
  let operationValidationError = null;
  try {
    validateOperation(candidate, { allowMissing: true });
  } catch (error) {
    if (error instanceof Error && /credential values are forbidden/.test(error.message)) throw error;
    operationValidationError = error instanceof Error ? error.message : "operation is invalid";
  }
  let providerApprovalValidationError = null;
  try {
    validateProviderApproval(candidate);
  } catch (error) {
    if (error instanceof Error && /secret-like values are forbidden/.test(error.message)) throw error;
    providerApprovalValidationError = error instanceof Error ? error.message : "provider approval is invalid";
  }
  return {
    id: requiredText(candidate.id, "candidate.id"),
    apiCatalog: candidate.apiCatalog !== false,
    displayName: candidate.displayName ?? null,
    domain: candidate.domain ?? null,
    detailUrl: candidate.detailUrl ?? null,
    searchTerms: candidate.evidence?.searchTerms ?? [],
    status: candidate.admissionStatus ?? null,
    endpoint: requiredText(candidate.requestUrl, `${candidate.id}.requestUrl`),
    sampleUrl: candidate.operation?.sampleUrl ?? candidate.evidence?.sampleUrl ?? null,
    responseFields: candidate.operation?.responseFields ?? candidate.evidence?.outputFields ?? [],
    providerApproval: candidate.providerApproval ?? null,
    providerApprovalValidationError,
    operation: candidate.operation ?? null,
    operationValidationError,
  };
}

export function listOperations(document) {
  const candidates = Array.isArray(document?.candidates) ? document.candidates : [];
  return candidates
    .filter((candidate) => typeof candidate.requestUrl === "string")
    .map(operationSummary)
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
}

export function operationHumanSummary(summary) {
  const lines = [
    `id: ${summary.id}`,
    `status: ${summary.status ?? "unknown"}`,
    `endpoint: ${summary.endpoint}`,
    `sample: ${summary.sampleUrl ?? "not documented"}`,
    `response fields: ${summary.responseFields.join(", ") || "not documented"}`,
  ];
  if (summary.providerApproval) {
    lines.push(
      `provider approval: ${summary.providerApproval.status}`,
      `provider approval scope: ${summary.providerApproval.approvalScope}`,
      `provider terms: ${summary.providerApproval.termsStatus}`,
      `provider quota: ${summary.providerApproval.quotaStatus}`,
      `provider production use: ${summary.providerApproval.productionUseAllowed ? "allowed" : "not allowed"}`,
      `provider operation: ${summary.providerApproval.serviceId}/${summary.providerApproval.operationId}`,
      `approval valid: ${summary.providerApproval.validFrom}..${summary.providerApproval.validTo}`,
    );
  } else {
    lines.push("provider approval: none");
  }
  if (summary.providerApprovalValidationError) {
    lines.push(`provider approval validation: ${summary.providerApprovalValidationError}`);
  }
  if (summary.operation && !summary.operationValidationError) {
    const runner = [summary.operation.runner.command, ...(summary.operation.runner.arguments ?? [])].join(" ");
    const fixedParameters = Object.entries(summary.operation.fixedParameters ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(", ") || "none";
    lines.push(
      `auth env: ${summary.operation.auth.env ?? "not required"}`,
      `auth value encoding: ${summary.operation.auth.valueEncoding ?? "provider default"}`,
      `auth load policy: ${summary.operation.auth.loadPolicy ?? "runtime default"}`,
      `required params: ${summary.operation.requiredParameters.join(", ")}`,
      `fixed params: ${fixedParameters}`,
      `optional params: ${(summary.operation.optionalParameters ?? []).join(", ") || "none"}`,
      `response envelope: ${summary.operation.responseEnvelope}`,
      `runner: ${runner}`,
      `runner env: ${summary.operation.runner.requiredEnv.join(", ")}`,
    );
  } else if (!summary.operation) {
    lines.push("operation: not documented");
  }
  if (summary.operationValidationError) {
    lines.push(`operation validation: ${summary.operationValidationError}`);
  }
  return lines.join("\n");
}

async function main(args = process.argv.slice(2)) {
  const githubOutputIndex = args.indexOf("--github-output");
  const githubOutput = githubOutputIndex === -1 ? null : requiredText(args[githubOutputIndex + 1], "--github-output");
  const positional = args.filter((arg, index) => arg !== "--json"
    && (githubOutputIndex === -1 || (index !== githubOutputIndex && index !== githubOutputIndex + 1)));
  const [command, sourceId] = positional;
  const json = args.includes("--json");
  const document = JSON.parse(await readFile(CANDIDATES_URL, "utf8"));
  const operations = listOperations(document);
  if (command === "list") {
    console.log(
      json
        ? JSON.stringify(operations, null, 2)
        : operations.map((entry) => `${entry.id}\t${entry.status ?? "unknown"}\t${entry.endpoint}`).join("\n"),
    );
    return;
  }
  if (command === "show" && sourceId) {
    const summary = operations.find((entry) => entry.id === sourceId);
    if (!summary) throw new Error(`source operation not found: ${sourceId}`);
    console.log(json ? JSON.stringify(summary, null, 2) : operationHumanSummary(summary));
    return;
  }
  if (command === "validate" && !sourceId) {
    validateSourceCandidateDocument(document);
    const candidates = document.candidates.filter((candidate) => candidate.operation != null);
    for (const candidate of candidates) validateOperation(candidate);
    console.log(`source operation contracts valid: ${candidates.length}`);
    return;
  }
  if (command === "check-approvals" && !sourceId) {
    const summary = providerApprovalExpirySummary(document);
    for (const approval of summary.approvals) {
      if (approval.daysUntilExpiry <= approval.renewalNoticeDays) {
        console.log(`::warning title=Provider approval expiry::${approval.candidateId} expires in ${approval.daysUntilExpiry} days (${approval.validTo})`);
      }
    }
    if (githubOutput) {
      await appendFile(
        githubOutput,
        `status=${summary.status}\napproved_count=${summary.approvals.length}\n`,
      );
    }
    console.log(`provider approval expiry: ${summary.status} (${summary.approvals.length} approved)`);
    return;
  }
  throw new Error("usage: source-operation.mjs list [--json] | show <source-id> [--json] | validate | check-approvals [--github-output <path>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "source operation failed");
    process.exitCode = 1;
  });
}
