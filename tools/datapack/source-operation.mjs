#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CANDIDATES_URL = new URL("./source-candidates.json", import.meta.url);
const CREDENTIAL_NAME = /^(?:accesskey|accesstoken|apikey|authorization|clientsecret|credential|key|password|privatekey|refreshtoken|secret|servicekey|signature|token|xamzcredential|xamzsecuritytoken|xamzsignature|xapikey)$/;

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
    "method", "endpoint", "auth", "requiredParameters", "responseEnvelope", "runner", "secretPolicy",
  ]), `${candidate.id}.operation`);
  if (!new Set(["GET", "POST"]).has(operation.method)) {
    throw new Error(`${candidate.id}.operation.method must be GET or POST`);
  }
  const operationUrl = requiredHttpUrl(operation.endpoint, `${candidate.id}.operation.endpoint`);
  if (operationUrl.href !== requestUrl.href) {
    throw new Error(`${candidate.id}.operation endpoint must match requestUrl`);
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
    credentialFree ? new Set(["placement"]) : new Set(["env", "placement", "parameter"]),
    `${candidate.id}.operation.auth`,
  );
  const authEnv = credentialFree ? null : requiredText(auth.env, `${candidate.id}.operation.auth.env`);
  if (authEnv != null && !/^[A-Z][A-Z0-9_]*$/.test(authEnv)) {
    throw new Error(`${candidate.id}.operation.auth.env must be an environment variable name`);
  }
  const authParameter = credentialFree
    ? null
    : requiredText(auth.parameter, `${candidate.id}.operation.auth.parameter`);
  const requiredParameters = stringList(
    operation.requiredParameters,
    `${candidate.id}.operation.requiredParameters`,
    { allowEmpty: true },
  );
  if (authParameter != null && !requiredParameters.includes(authParameter)) {
    throw new Error(`${candidate.id}.operation.requiredParameters must include the auth parameter`);
  }
  requiredText(operation.responseEnvelope, `${candidate.id}.operation.responseEnvelope`);
  const runner = operation.runner;
  if (!runner || typeof runner !== "object" || Array.isArray(runner)) {
    throw new Error(`${candidate.id}.operation.runner must be an object`);
  }
  requireAllowedKeys(runner, new Set(["command", "requiredEnv"]), `${candidate.id}.operation.runner`);
  const command = requiredText(runner.command, `${candidate.id}.operation.runner.command`);
  if (!/^node tools\/[A-Za-z0-9_./-]+\.mjs$/.test(command)) {
    throw new Error(`${candidate.id}.operation.runner.command must be a literal repository Node command`);
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
  validateOperation(candidate, { allowMissing: true });
  return {
    id: requiredText(candidate.id, "candidate.id"),
    status: candidate.admissionStatus ?? null,
    endpoint: requiredText(candidate.requestUrl, `${candidate.id}.requestUrl`),
    sampleUrl: candidate.evidence?.sampleUrl ?? null,
    responseFields: candidate.evidence?.outputFields ?? [],
    operation: candidate.operation ?? null,
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
  if (summary.operation) {
    lines.push(
      `auth env: ${summary.operation.auth.env ?? "not required"}`,
      `required params: ${summary.operation.requiredParameters.join(", ")}`,
      `response envelope: ${summary.operation.responseEnvelope}`,
      `runner: ${summary.operation.runner.command}`,
      `runner env: ${summary.operation.runner.requiredEnv.join(", ")}`,
    );
  } else {
    lines.push("operation: not documented");
  }
  return lines.join("\n");
}

async function main(args = process.argv.slice(2)) {
  const [command, sourceId] = args.filter((arg) => arg !== "--json");
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
    const candidates = document.candidates.filter((candidate) => candidate.operation != null);
    for (const candidate of candidates) validateOperation(candidate);
    console.log(`source operation contracts valid: ${candidates.length}`);
    return;
  }
  throw new Error("usage: source-operation.mjs list [--json] | show <source-id> [--json] | validate");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "source operation failed");
    process.exitCode = 1;
  });
}
