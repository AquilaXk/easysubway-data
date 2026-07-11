#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

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
]);

const KRIC_ORIGIN = "https://openapi.kric.go.kr";
const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TOOL_DIRECTORY, "../..");
const CANDIDATES_PATH = path.join(TOOL_DIRECTORY, "source-candidates.json");
const execFileAsync = promisify(execFile);

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function assertKricUrl(url, label) {
  if (url.origin !== KRIC_ORIGIN) {
    throw new Error(`${label} provider origin must be ${KRIC_ORIGIN}`);
  }
  if (!url.pathname.startsWith("/openapi/") || url.username || url.password || url.hash) {
    throw new Error(`${label} must be a credential-free KRIC OpenAPI URL`);
  }
}

export function resolveKricCandidateRequest(candidatesDocument, candidateId) {
  if (!KRIC_SOURCE_CANDIDATE_IDS.includes(candidateId)) {
    throw new Error(`candidate is not allowed: ${candidateId}`);
  }

  const candidate = candidatesDocument.candidates?.find((entry) => entry.id === candidateId);
  if (!candidate) {
    throw new Error(`tracked candidate metadata is missing: ${candidateId}`);
  }
  if (candidate.sampleEvidenceStatus !== "sample_url_documented_key_required") {
    throw new Error(`${candidateId} sample evidence status is not pending`);
  }
  if (candidate.admissionStatus !== "evidence_recorded_admin_review_required") {
    throw new Error(`${candidateId} admission status no longer requires admin review`);
  }

  const endpoint = new URL(requiredText(candidate.evidence?.endpoint, `${candidateId}.evidence.endpoint`));
  const requestUrl = new URL(requiredText(candidate.requestUrl, `${candidateId}.requestUrl`));
  const sampleUrl = new URL(requiredText(candidate.evidence?.sampleUrl, `${candidateId}.evidence.sampleUrl`));
  assertKricUrl(endpoint, `${candidateId}.evidence.endpoint`);
  assertKricUrl(requestUrl, `${candidateId}.requestUrl`);
  assertKricUrl(sampleUrl, `${candidateId}.evidence.sampleUrl`);

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

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--candidate" || !argv[1] || argv[1].startsWith("--")) {
    throw new Error("usage: collect-kric-source-candidate-evidence.mjs --candidate <fixed-candidate-id>");
  }
  return { candidateId: argv[1] };
}

function sanitizeErrorMessage(error, serviceKey) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [serviceKey, encodeURIComponent(serviceKey)]) {
    if (value) {
      message = message.replaceAll(value, "[REDACTED]");
    }
  }
  return message.replace(/([?&]serviceKey=)[^&\s]+/gi, "$1[REDACTED]");
}

async function runEvidenceTool(scriptName, args) {
  return execFileAsync(process.execPath, [path.join(TOOL_DIRECTORY, scriptName), ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
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
  const request = resolveKricCandidateRequest(document, candidateId);
  const outputDirectory = path.join(runnerTemp, "kric-source-candidate-evidence");
  const stagingDirectory = path.join(runnerTemp, "kric-source-candidate-staging");
  const rawDirectory = path.join(runnerTemp, "kric-source-candidate-raw");
  const rawPath = path.join(rawDirectory, `${candidateId}.response`);
  const stagedSamplePath = path.join(stagingDirectory, `${candidateId}.sample.json`);
  const stagedReportPath = path.join(stagingDirectory, `${candidateId}.report.txt`);
  const stagedHashesPath = path.join(stagingDirectory, `${candidateId}.hashes.json`);
  const samplePath = path.join(outputDirectory, path.basename(stagedSamplePath));
  const reportPath = path.join(outputDirectory, path.basename(stagedReportPath));
  const hashesPath = path.join(outputDirectory, path.basename(stagedHashesPath));

  await rm(outputDirectory, { recursive: true, force: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  await rm(rawDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(rawDirectory, { recursive: true, mode: 0o700 });

  let completed = false;
  try {
    const liveUrl = new URL(request.sampleUrl);
    liveUrl.searchParams.set("serviceKey", serviceKey);
    const response = await fetchImpl(liveUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: request.format === "json" ? "application/json" : "application/xml,text/xml" },
    });
    if (!response.ok) {
      throw new Error(`KRIC request failed with HTTP ${response.status}`);
    }
    await writeFile(rawPath, await response.text(), { mode: 0o600 });

    const { stdout: sample } = await runEvidenceTool("build-source-candidate-sample-evidence.mjs", [
      "--candidate", candidateId,
      "--candidates", CANDIDATES_PATH,
      "--response", rawPath,
      "--format", request.format,
    ]);
    JSON.parse(sample);
    await writeFile(stagedSamplePath, sample, { mode: 0o600 });

    const { stdout: report } = await runEvidenceTool("validate-source-candidate-sample.mjs", [
      "--candidate", candidateId,
      "--candidates", CANDIDATES_PATH,
      "--sample", stagedSamplePath,
    ]);
    await writeFile(stagedReportPath, report, { mode: 0o600 });

    const evidence = JSON.parse(sample);
    const hashes = {
      candidateId,
      rawSha256: evidence.rawSha256,
      schemaFingerprint: evidence.schemaFingerprint,
      evidenceHash: evidence.evidenceHash,
      providerRecordHashes: evidence.providerRecordHashes,
    };
    await writeFile(stagedHashesPath, `${JSON.stringify(hashes, null, 2)}\n`, { mode: 0o600 });

    for (const outputPath of [stagedSamplePath, stagedReportPath, stagedHashesPath]) {
      if (!(await readFile(outputPath, "utf8")).trim()) {
        throw new Error(`sanitized evidence output is empty: ${path.basename(outputPath)}`);
      }
    }

    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await rename(stagedSamplePath, samplePath);
    await rename(stagedReportPath, reportPath);
    await rename(stagedHashesPath, hashesPath);
    completed = true;
    return { sample: samplePath, report: reportPath, hashes: hashesPath };
  } catch (error) {
    throw new Error(sanitizeErrorMessage(error, serviceKey));
  } finally {
    await rm(rawDirectory, { recursive: true, force: true });
    await rm(stagingDirectory, { recursive: true, force: true });
    if (!completed) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}

async function main() {
  const { candidateId } = parseCli(process.argv.slice(2));
  await collectKricSourceCandidateEvidence({ candidateId });
  console.log(`sanitized KRIC source candidate evidence ready: ${candidateId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(sanitizeErrorMessage(error, process.env.KRIC_SERVICE_KEY ?? ""));
    process.exitCode = 1;
  });
}
