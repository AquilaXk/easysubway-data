#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CANDIDATES_PATH,
  collectSourceCandidateEvidence,
  parseCli,
  requiredText,
  sanitizeErrorMessage,
} from "./lib/source-candidate-evidence-collector.mjs";

export const DATAGO_SOURCE_CANDIDATE_IDS = Object.freeze([
  "seoul-metro-transfer-distance-duration",
  "seoul-metro-fast-exit-car-door",
  "seoul-metro-accessibility",
  "seoul-metro-facility-location",
]);

const DATAGO_REST_ORIGIN = "https://apis.data.go.kr";
const DATAGO_FILE_ORIGINS = new Set(["https://api.odcloud.kr", "https://www.data.go.kr"]);

// data.go.kr이 GitHub secret에 URL 인코딩된 서비스키를 저장해 둔 경우, URLSearchParams가 이를 다시
// 인코딩해 이중 인코딩된 키를 전송하는 문제를 막는다. probe-seoul-fare-api.mjs의 decodedServiceKey()와
// 동일한 로직(멱등): "%xx" 패턴이 있을 때만 decodeURIComponent로 정규화하고, 없으면 그대로 둔다.
function decodedServiceKey(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeDatagoErrorMessage(error, rawServiceKey) {
  const normalizedServiceKey = decodedServiceKey(rawServiceKey);
  const message = sanitizeErrorMessage(error, rawServiceKey);
  return normalizedServiceKey === rawServiceKey
    ? message
    : sanitizeErrorMessage(new Error(message), normalizedServiceKey);
}

function assertDatagoUrl(url, label) {
  const isRest = url.origin === DATAGO_REST_ORIGIN;
  const isFile = DATAGO_FILE_ORIGINS.has(url.origin);
  if (!isRest && !isFile) {
    throw new Error(`${label} provider origin must be a data.go.kr origin`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${label} must be a credential-free data.go.kr URL`);
  }
}

export function resolveDatagoCandidateRequest(candidatesDocument, candidateId) {
  if (!DATAGO_SOURCE_CANDIDATE_IDS.includes(candidateId)) {
    throw new Error(`candidate is not allowed: ${candidateId}`);
  }

  const candidate = candidatesDocument.candidates?.find((entry) => entry.id === candidateId);
  if (!candidate) {
    throw new Error(`tracked candidate metadata is missing: ${candidateId}`);
  }
  if (!candidate.evidence?.sampleUrl || !candidate.evidence?.endpoint || !candidate.requestUrl) {
    throw new Error(`${candidateId} endpoint not yet confirmed; cannot collect until data.go.kr endpoint is documented`);
  }

  const endpoint = new URL(requiredText(candidate.evidence?.endpoint, `${candidateId}.evidence.endpoint`));
  const requestUrl = new URL(requiredText(candidate.requestUrl, `${candidateId}.requestUrl`));
  const sampleUrl = new URL(requiredText(candidate.evidence?.sampleUrl, `${candidateId}.evidence.sampleUrl`));
  assertDatagoUrl(endpoint, `${candidateId}.evidence.endpoint`);
  assertDatagoUrl(requestUrl, `${candidateId}.requestUrl`);
  assertDatagoUrl(sampleUrl, `${candidateId}.evidence.sampleUrl`);

  if (requestUrl.href !== endpoint.href) {
    throw new Error(`${candidateId} requestUrl must match evidence endpoint`);
  }
  if (sampleUrl.origin !== endpoint.origin || sampleUrl.pathname !== endpoint.pathname) {
    throw new Error(`${candidateId} sampleUrl must use the tracked evidence endpoint`);
  }
  const serviceKeys = [...sampleUrl.searchParams.entries()]
    .filter(([name]) => name.toLowerCase() === "servicekey");
  if (serviceKeys.length !== 1 || serviceKeys[0][0] !== "serviceKey" || serviceKeys[0][1] !== "[서비스키값]") {
    throw new Error(`${candidateId} sampleUrl must contain exactly one redacted serviceKey`);
  }

  const formatParam = ["format", "dataType", "_type", "returnType"]
    .map((name) => sampleUrl.searchParams.get(name))
    .find((value) => value !== null);
  const format = requiredText(formatParam, `${candidateId} sample format`).toLowerCase();
  if (format === "csv") {
    throw new Error(`${candidateId} csv sample collection not yet supported`);
  }
  const supportedFormats = new Set((candidate.evidence?.formats ?? []).map((value) => String(value).toLowerCase()));
  if (!new Set(["json", "xml"]).has(format) || !supportedFormats.has(format)) {
    throw new Error(`${candidateId} sample format is not supported: ${format}`);
  }

  return {
    candidateId,
    endpoint: endpoint.href,
    format,
    sampleUrl,
  };
}

export async function collectDatagoSourceCandidateEvidence({
  candidateId,
  candidatesDocument,
  fetchImpl = fetch,
  runnerTemp = process.env.RUNNER_TEMP,
  serviceKey = process.env.DATA_GO_KR_SERVICE_KEY,
} = {}) {
  requiredText(serviceKey, "DATA_GO_KR_SERVICE_KEY");
  if (!path.isAbsolute(requiredText(runnerTemp, "RUNNER_TEMP"))) {
    throw new Error("RUNNER_TEMP must be an absolute path");
  }
  const document = candidatesDocument ?? JSON.parse(await readFile(CANDIDATES_PATH, "utf8"));
  const request = resolveDatagoCandidateRequest(document, candidateId);
  const normalizedServiceKey = decodedServiceKey(serviceKey);
  try {
    return await collectSourceCandidateEvidence({
      candidateId,
      candidatesDocument,
      fetchImpl,
      runnerTemp,
      serviceKey: normalizedServiceKey,
      serviceKeyLabel: "DATA_GO_KR_SERVICE_KEY",
      directoryPrefix: "datago-source-candidate",
      request,
      requestFailureLabel: "data.go.kr request failed with HTTP",
      diagnosticLabel: "Data.go.kr XML diagnostic:",
      writeStagedCandidates: Boolean(candidatesDocument),
      buildScriptName: "build-source-candidate-sample-evidence.mjs",
      validateScriptName: "validate-source-candidate-sample.mjs",
    });
  } catch (error) {
    throw new Error(sanitizeDatagoErrorMessage(error, serviceKey));
  }
}

async function main() {
  const { candidateId } = parseCli(process.argv.slice(2), "collect-datago-source-candidate-evidence.mjs");
  await collectDatagoSourceCandidateEvidence({ candidateId });
  console.log(`sanitized data.go.kr source candidate evidence ready: ${candidateId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(sanitizeDatagoErrorMessage(error, process.env.DATA_GO_KR_SERVICE_KEY ?? ""));
    process.exitCode = 1;
  });
}
