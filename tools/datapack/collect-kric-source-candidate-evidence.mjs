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
import {
  assertProviderCredentialIntegrity,
  resolveProviderCallIntegrity,
} from "./lib/provider-call-integrity.mjs";

const KRIC_PROVIDER_ID = "kric";

export const KRIC_SOURCE_CANDIDATE_IDS = Object.freeze([
  "kric-subway-route-info",
  "kric-station-info",
  "kric-train-operation-organ",
  "kric-station-transfer-info",
  "kric-station-platform",
  "kric-station-movement-standard",
  "kric-station-movement-detailed",
  "kric-transfer-movement-standard",
  "kric-transfer-movement-detailed",
  "kric-station-convenience-standard",
  "kric-station-elevator",
  "kric-station-elevator-movement",
  "kric-station-escalator",
  "kric-wheelchair-lift-location",
  "kric-wheelchair-lift-movement",
]);

const KRIC_ORIGIN = "https://openapi.kric.go.kr";

function assertKricUrl(url, label) {
  if (url.origin !== KRIC_ORIGIN) {
    throw new Error(`${label} provider origin must be ${KRIC_ORIGIN}`);
  }
  if (!url.pathname.startsWith("/openapi/") || url.username || url.password || url.hash) {
    throw new Error(`${label} must be a credential-free KRIC OpenAPI URL`);
  }
}

// #22: 대조군 URL에는 라이브 serviceKey가 치환돼 나간다. 본 요청과 같은 KRIC origin 불변식을 적용하고
// 추적 중인 카탈로그 candidate에 바인딩해, 계약 문서만으로 임의 호스트에 자격증명이 나가지 못하게 한다.
export function assertKricControlOperation(candidatesDocument, controlOperation) {
  const label = "kric.controlOperation";
  assertKricUrl(new URL(controlOperation.endpoint), `${label}.endpoint`);
  assertKricUrl(new URL(controlOperation.sampleUrl), `${label}.sampleUrl`);

  const control = candidatesDocument.candidates?.find((entry) => entry.id === controlOperation.candidateId);
  if (!control) {
    throw new Error(`${label} candidate is not tracked: ${controlOperation.candidateId}`);
  }
  if (controlOperation.endpoint !== control.requestUrl) {
    throw new Error(`${label} must match the tracked candidate request URL`);
  }
  if (controlOperation.sampleUrl !== (control.operation?.sampleUrl ?? control.evidence?.sampleUrl)) {
    throw new Error(`${label} must match the tracked candidate sample URL`);
  }
  return controlOperation;
}

export function resolveKricCandidateRequest(candidatesDocument, candidateId) {
  if (!KRIC_SOURCE_CANDIDATE_IDS.includes(candidateId)) {
    throw new Error(`candidate is not allowed: ${candidateId}`);
  }

  const candidate = candidatesDocument.candidates?.find((entry) => entry.id === candidateId);
  if (!candidate) {
    throw new Error(`tracked candidate metadata is missing: ${candidateId}`);
  }
  const usesOperationSample = candidate.operation?.sampleUrl != null;
  const endpoint = new URL(requiredText(
    usesOperationSample ? candidate.operation?.endpoint : candidate.evidence?.endpoint,
    usesOperationSample ? `${candidateId}.operation.endpoint` : `${candidateId}.evidence.endpoint`,
  ));
  const requestUrl = new URL(requiredText(candidate.requestUrl, `${candidateId}.requestUrl`));
  const sampleUrl = new URL(requiredText(
    usesOperationSample ? candidate.operation?.sampleUrl : candidate.evidence?.sampleUrl,
    usesOperationSample ? `${candidateId}.operation.sampleUrl` : `${candidateId}.evidence.sampleUrl`,
  ));
  assertKricUrl(endpoint, usesOperationSample ? `${candidateId}.operation.endpoint` : `${candidateId}.evidence.endpoint`);
  assertKricUrl(requestUrl, `${candidateId}.requestUrl`);
  assertKricUrl(sampleUrl, usesOperationSample ? `${candidateId}.operation.sampleUrl` : `${candidateId}.evidence.sampleUrl`);

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

  const format = requiredText(sampleUrl.searchParams.get("format"), `${candidateId} sample format`).toLowerCase();
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

export async function collectKricSourceCandidateEvidence({
  candidateId,
  candidatesDocument,
  fetchImpl = fetch,
  runnerTemp = process.env.RUNNER_TEMP,
  serviceKey = process.env.KRIC_SERVICE_KEY,
} = {}) {
  requiredText(serviceKey, "KRIC_SERVICE_KEY");
  if (!path.isAbsolute(requiredText(runnerTemp, "RUNNER_TEMP"))) {
    throw new Error("RUNNER_TEMP must be an absolute path");
  }
  const document = candidatesDocument ?? JSON.parse(await readFile(CANDIDATES_PATH, "utf8"));
  // #22: 저장소 카탈로그로 실행할 때는 provider 호출 정합성 계약을 반드시 통과해야 한다.
  // 주입된 문서는 계약을 선언한 경우에만 검사한다.
  const integrity = resolveProviderCallIntegrity(document, KRIC_PROVIDER_ID, { required: candidatesDocument == null });
  if (integrity != null) {
    assertProviderCredentialIntegrity({
      providerId: KRIC_PROVIDER_ID,
      credential: serviceKey,
      contract: integrity.credential,
    });
    assertKricControlOperation(document, integrity.controlOperation);
  }
  const request = resolveKricCandidateRequest(document, candidateId);
  const effectiveDocument = {
    ...document,
    candidates: document.candidates.map((candidate) => candidate.id !== candidateId
      ? candidate
      : {
          ...candidate,
          evidence: {
            ...candidate.evidence,
            ...(candidate.operation?.sampleUrl
              ? { endpoint: candidate.operation.endpoint, sampleUrl: candidate.operation.sampleUrl }
              : {}),
            ...(candidate.operation?.responseFields
              ? { outputFields: candidate.operation.responseFields }
              : {}),
          },
        }),
  };
  return collectSourceCandidateEvidence({
    candidateId,
    candidatesDocument: effectiveDocument,
    fetchImpl,
    runnerTemp,
    serviceKey,
    serviceKeyLabel: "KRIC_SERVICE_KEY",
    directoryPrefix: "kric-source-candidate",
    request,
    requestFailureLabel: "KRIC request failed with HTTP",
    diagnosticLabel: "KRIC XML diagnostic:",
    writeStagedCandidates: true,
    buildScriptName: "build-source-candidate-sample-evidence.mjs",
    validateScriptName: "validate-source-candidate-sample.mjs",
    controlOperation: integrity?.controlOperation ?? null,
    credentialSignalResultCodes: integrity?.credentialSignalResultCodes ?? null,
  });
}

async function main() {
  const { candidateId } = parseCli(process.argv.slice(2), "collect-kric-source-candidate-evidence.mjs");
  await collectKricSourceCandidateEvidence({ candidateId });
  console.log(`sanitized KRIC source candidate evidence ready: ${candidateId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(sanitizeErrorMessage(error, process.env.KRIC_SERVICE_KEY ?? ""));
    process.exitCode = 1;
  });
}
