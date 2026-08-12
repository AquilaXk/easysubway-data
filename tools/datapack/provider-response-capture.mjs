import { createHash } from "node:crypto";

const DEFAULT_MAX_RECORDS = 2_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const ALLOWED_ORIGIN = "https://apis.data.go.kr";

class ProviderCaptureIntegrityError extends Error {}

export function createProviderResponseRecorder({
  fetchImpl = fetch,
  observedAt,
  selectedServiceDates,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const normalizedObservedAt = requiredIsoInstant(observedAt, "observedAt");
  const normalizedServiceDates = requiredServiceDates(selectedServiceDates);
  requiredLimit(maxRecords, DEFAULT_MAX_RECORDS, "maxRecords");
  requiredNonnegativeLimit(maxBodyBytes, DEFAULT_MAX_BODY_BYTES, "maxBodyBytes");
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function");

  const records = [];
  let bodyBytes = 0;
  let integrityFailure = false;

  const captureFetch = async (input, init = {}) => {
    const { identity: request, credentials } = providerRequest(input, init);
    if (records.length >= maxRecords) {
      throw new ProviderCaptureIntegrityError("provider capture record limit exceeded");
    }
    const index = records.length;
    const record = { index, request, outcome: { kind: "PENDING" } };
    records.push(record);
    try {
      const response = await fetchImpl(input, init);
      if (!(response instanceof Response)) throw new ProviderCaptureIntegrityError("provider fetch must return a Response");

      const body = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type");
      const retryAfter = response.headers.get("retry-after");
      rejectCredentialEcho(credentials, [body.toString("utf8"), contentType, retryAfter]);
      if (bodyBytes + body.length > maxBodyBytes) {
        throw new ProviderCaptureIntegrityError("provider capture body limit exceeded");
      }
      bodyBytes += body.length;
      record.outcome = {
        kind: "RESPONSE",
        response: {
          status: response.status,
          headers: {
            contentType: contentType === null ? null : contentType,
            retryAfter: retryAfter === null ? null : retryAfter,
          },
          bodyBase64: body.toString("base64"),
          bodySha256: sha256(body),
        },
      };
      return responseFromRecord(record.outcome.response);
    } catch (error) {
      record.outcome = { kind: "TRANSPORT_FAILURE" };
      if (error instanceof ProviderCaptureIntegrityError) integrityFailure = true;
      throw error;
    }
  };

  return {
    fetchImpl: captureFetch,
    captureArtifact() {
      if (records.some(({ outcome }) => outcome.kind === "PENDING")) {
        throw new Error("provider capture has pending requests");
      }
      if (integrityFailure) throw new Error("provider capture integrity failure");
      return captureWithDigest({
        schemaVersion: 1,
        artifactKind: "provider-response-capture",
        observedAt: normalizedObservedAt,
        selectedServiceDates: normalizedServiceDates,
        requestCount: records.length,
        bodyBytes,
        records: structuredClone(records),
      });
    },
  };
}

export function createProviderResponseReplay({ captureBytes } = {}) {
  const capture = parseProviderResponseCapture(captureBytes);
  let index = 0;
  return {
    capture,
    async fetchImpl(input, init = {}) {
      if (index >= capture.records.length) throw new Error("provider replay is exhausted");
      const record = capture.records[index];
      const actual = providerRequest(input, init).identity;
      if (JSON.stringify(actual) !== JSON.stringify(record.request)) {
        throw new Error(`provider replay request mismatch at index ${index}`);
      }
      index += 1;
      if (record.outcome.kind === "TRANSPORT_FAILURE") {
        throw new Error("provider replay transport failure");
      }
      return responseFromRecord(record.outcome.response);
    },
    assertExhausted() {
      const remaining = capture.records.length - index;
      if (remaining !== 0) throw new Error(`provider replay has ${remaining} unconsumed record${remaining === 1 ? "" : "s"}`);
    },
  };
}

export function createProviderResponseContinuation({
  captureBytes,
  fetchImpl = fetch,
  observedAt,
  allowLiveRequest,
  maxLiveRequests = 18,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const capture = parseProviderResponseCapture(captureBytes);
  const normalizedObservedAt = requiredIsoInstant(observedAt, "observedAt");
  const selectedServiceDates = requiredServiceDates(capture.selectedServiceDates);
  requiredLimit(maxLiveRequests, DEFAULT_MAX_RECORDS, "maxLiveRequests");
  requiredNonnegativeLimit(maxBodyBytes, DEFAULT_MAX_BODY_BYTES, "maxBodyBytes");
  if (capture.requestCount + maxLiveRequests > DEFAULT_MAX_RECORDS) {
    throw new Error("provider continuation record limit exceeded");
  }
  if (capture.bodyBytes > maxBodyBytes) throw new Error("provider continuation body limit exceeded");
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function");
  if (typeof allowLiveRequest !== "function") throw new Error("allowLiveRequest must be a function");

  const baseQueues = new Map();
  const baseIdentityKeys = new Set();
  for (const record of capture.records) {
    const key = JSON.stringify(record.request);
    baseIdentityKeys.add(key);
    if (!baseQueues.has(key)) baseQueues.set(key, []);
    baseQueues.get(key).push(record.index);
  }
  const consumedBase = new Set();
  const consumptionOrder = [];
  let invalidReason = null;
  let liveRequestCount = 0;
  const liveRecorder = createProviderResponseRecorder({
    fetchImpl,
    observedAt: normalizedObservedAt,
    selectedServiceDates,
    maxRecords: maxLiveRequests,
    maxBodyBytes: maxBodyBytes - capture.bodyBytes,
  });

  const invalidate = (message) => {
    invalidReason ??= message;
    throw new Error(message);
  };

  return {
    baseContentSha256: capture.contentSha256,
    baseRequestCount: capture.requestCount,
    selectedServiceDates,
    get liveRequestCount() {
      return liveRequestCount;
    },
    async fetchImpl(input, init = {}) {
      if (invalidReason !== null) throw new Error(invalidReason);
      const identity = providerRequest(input, init).identity;
      const key = JSON.stringify(identity);
      const queue = baseQueues.get(key);
      if (queue?.length > 0) {
        const index = queue.shift();
        consumedBase.add(index);
        consumptionOrder.push({ kind: "BASE", index });
        const record = capture.records[index];
        if (record.outcome.kind === "TRANSPORT_FAILURE") {
          throw new Error("provider continuation base transport failure");
        }
        return responseFromRecord(record.outcome.response);
      }
      if (baseIdentityKeys.has(key)) invalidate("provider continuation base request overconsumed");

      let allowed = false;
      try {
        allowed = allowLiveRequest(structuredClone(identity)) === true;
      } catch {
        invalidate("provider continuation live request is not allowed");
      }
      if (!allowed) invalidate("provider continuation live request is not allowed");
      if (liveRequestCount >= maxLiveRequests) invalidate("provider continuation live request limit exceeded");
      const liveIndex = liveRequestCount;
      liveRequestCount += 1;
      consumptionOrder.push({ kind: "LIVE", index: liveIndex });
      try {
        return await liveRecorder.fetchImpl(input, init);
      } catch (error) {
        if (error instanceof ProviderCaptureIntegrityError) {
          invalidReason = "provider continuation live capture integrity failed";
        }
        throw error;
      }
    },
    captureArtifact() {
      if (invalidReason !== null) throw new Error(invalidReason);
      const remaining = capture.requestCount - consumedBase.size;
      if (remaining !== 0) {
        throw new Error(`provider continuation has ${remaining} unconsumed base record${remaining === 1 ? "" : "s"}`);
      }
      const liveCapture = liveRecorder.captureArtifact();
      const records = consumptionOrder.map(({ kind, index: sourceIndex }, index) => ({
        ...structuredClone(kind === "BASE" ? capture.records[sourceIndex] : liveCapture.records[sourceIndex]),
        index,
      }));
      return captureWithDigest({
        schemaVersion: 1,
        artifactKind: "provider-response-capture",
        observedAt: normalizedObservedAt,
        selectedServiceDates,
        requestCount: records.length,
        bodyBytes: capture.bodyBytes + liveCapture.bodyBytes,
        records,
      });
    },
  };
}

export function providerResponseCaptureBytes(capture) {
  const validated = validateCapture(structuredClone(capture));
  return Buffer.from(`${JSON.stringify(validated, null, 2)}\n`);
}

export function parseProviderResponseCapture(bytes) {
  const input = Buffer.from(bytes ?? []);
  let parsed;
  try {
    parsed = JSON.parse(input.toString("utf8"));
  } catch {
    throw new Error("provider capture must be JSON");
  }
  const validated = validateCapture(parsed);
  if (!input.equals(Buffer.from(`${JSON.stringify(validated, null, 2)}\n`))) {
    throw new Error("provider capture must be canonical JSON");
  }
  return validated;
}

function validateCapture(capture) {
  exactKeys(capture, [
    "artifactKind", "bodyBytes", "contentSha256", "observedAt", "records",
    "requestCount", "schemaVersion", "selectedServiceDates",
  ], "provider capture");
  if (capture.schemaVersion !== 1 || capture.artifactKind !== "provider-response-capture") {
    throw new Error("provider capture identity is invalid");
  }
  requiredIsoInstant(capture.observedAt, "provider capture observedAt");
  requiredServiceDates(capture.selectedServiceDates);
  if (!Array.isArray(capture.records) || capture.records.length > DEFAULT_MAX_RECORDS
    || capture.requestCount !== capture.records.length) {
    throw new Error("provider capture request count is invalid");
  }
  let bodyBytes = 0;
  capture.records.forEach((record, index) => {
    exactKeys(record, ["index", "outcome", "request"], `provider capture record ${index}`);
    if (record.index !== index) throw new Error("provider capture record index is invalid");
    validateRequestIdentity(record.request);
    if (record.outcome?.kind === "TRANSPORT_FAILURE") {
      exactKeys(record.outcome, ["kind"], `provider capture outcome ${index}`);
      return;
    }
    exactKeys(record.outcome, ["kind", "response"], `provider capture outcome ${index}`);
    if (record.outcome.kind !== "RESPONSE") throw new Error("provider capture outcome is invalid");
    const response = record.outcome.response;
    exactKeys(response, ["bodyBase64", "bodySha256", "headers", "status"], `provider capture response ${index}`);
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
      throw new Error("provider capture response status is invalid");
    }
    exactKeys(response.headers, ["contentType", "retryAfter"], `provider capture response headers ${index}`);
    for (const value of [response.headers.contentType, response.headers.retryAfter]) {
      if (value !== null && (typeof value !== "string" || /[\r\n]/.test(value))) {
        throw new Error("provider capture response header is invalid");
      }
    }
    if (typeof response.bodyBase64 !== "string") throw new Error("provider capture body is invalid");
    const body = Buffer.from(response.bodyBase64, "base64");
    if (body.toString("base64") !== response.bodyBase64) throw new Error("provider capture body is invalid");
    if (response.bodySha256 !== sha256(body)) throw new Error("provider capture body digest mismatch");
    bodyBytes += body.length;
  });
  if (bodyBytes > DEFAULT_MAX_BODY_BYTES || capture.bodyBytes !== bodyBytes) {
    throw new Error("provider capture body count is invalid");
  }
  const { contentSha256, ...content } = capture;
  if (!/^[0-9a-f]{64}$/.test(contentSha256) || contentSha256 !== sha256(Buffer.from(JSON.stringify(content)))) {
    throw new Error("provider capture content digest mismatch");
  }
  return capture;
}

function captureWithDigest(content) {
  return { ...content, contentSha256: sha256(Buffer.from(JSON.stringify(content))) };
}

function providerRequest(input, init) {
  const source = input instanceof Request ? input.url : input;
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error("provider request URL is invalid");
  }
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" || init?.body !== undefined) throw new Error("provider request method must be GET");
  if (url.origin !== ALLOWED_ORIGIN || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("provider request origin is not allowed");
  }
  const headers = init?.headers === undefined && input instanceof Request
    ? input.headers
    : new Headers(init?.headers);
  if ([...headers.keys()].some(isCredentialHeaderName)) {
    throw new Error("provider request credential header is not allowed");
  }
  const entries = [...url.searchParams.entries()];
  const credentials = entries
    .filter(([name]) => name.toLowerCase() === "servicekey")
    .map(([, value]) => value)
    .filter((value) => value.length > 0);
  const query = entries
    .filter(([name]) => name.toLowerCase() !== "servicekey")
    .sort(([leftName, leftValue], [rightName, rightValue]) => (
      codepointCompare(leftName, rightName) || codepointCompare(leftValue, rightValue)
    ));
  const identity = { method, origin: ALLOWED_ORIGIN, path: url.pathname, query };
  validateRequestIdentity(identity);
  return { identity, credentials };
}

function isCredentialHeaderName(name) {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return normalized === "authorization" || normalized === "proxyauthorization"
    || ["apikey", "accesstoken", "refreshtoken", "clientsecret", "credential", "password", "privatekey", "secret", "signature", "token"]
      .some((suffix) => normalized.endsWith(suffix));
}

function rejectCredentialEcho(credentials, values) {
  const representations = new Set(credentials.flatMap((credential) => [credential, encodeURIComponent(credential)]));
  for (const value of values) {
    if (typeof value === "string" && [...representations].some((credential) => credential !== "" && value.includes(credential))) {
      throw new ProviderCaptureIntegrityError("provider capture credential echo rejected");
    }
  }
}

function validateRequestIdentity(identity) {
  exactKeys(identity, ["method", "origin", "path", "query"], "provider request identity");
  if (identity.method !== "GET" || identity.origin !== ALLOWED_ORIGIN
    || typeof identity.path !== "string" || !identity.path.startsWith("/")
    || identity.path.includes("\0") || !Array.isArray(identity.query)) {
    throw new Error("provider request identity is invalid");
  }
  const sorted = identity.query.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((value) => typeof value !== "string" || /[\r\n]/.test(value))) {
      throw new Error("provider request query is invalid");
    }
    if (pair[0].toLowerCase() === "servicekey") throw new Error("provider request credential must be redacted");
    return pair;
  }).sort(([leftName, leftValue], [rightName, rightValue]) => (
    codepointCompare(leftName, rightName) || codepointCompare(leftValue, rightValue)
  ));
  if (JSON.stringify(sorted) !== JSON.stringify(identity.query)) throw new Error("provider request query order is invalid");
}

function responseFromRecord(response) {
  const body = Buffer.from(response.bodyBase64, "base64");
  const headers = new Headers();
  if (response.headers.contentType !== null) headers.set("content-type", response.headers.contentType);
  if (response.headers.retryAfter !== null) headers.set("retry-after", response.headers.retryAfter);
  const noBodyStatus = response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(noBodyStatus ? null : body, { status: response.status, headers });
}

function requiredServiceDates(value) {
  exactKeys(value, ["7", "8", "9"], "selectedServiceDates");
  for (const dayCd of ["7", "8", "9"]) {
    if (!/^\d{8}$/.test(value[dayCd])) throw new Error("selectedServiceDates is invalid");
  }
  return Object.freeze({ "7": value["7"], "8": value["8"], "9": value["9"] });
}

function requiredIsoInstant(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO instant`);
  }
  return value;
}

function requiredLimit(value, maximum, label) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${label} is invalid`);
}

function requiredNonnegativeLimit(value, maximum, label) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error(`${label} is invalid`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const actual = Object.keys(value).sort(codepointCompare);
  const sortedExpected = [...expected].sort(codepointCompare);
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) throw new Error(`${label} fields are invalid`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
