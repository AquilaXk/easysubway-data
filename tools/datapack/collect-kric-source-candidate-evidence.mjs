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
const SAFE_PLACEHOLDER = "[unsafe]";
const MISSING_PLACEHOLDER = "[missing]";
const ALLOWED_CONTENT_TYPES = new Set(["application/xml", "text/xml"]);
const SAFE_XML_TAG = /^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/;
const SENSITIVE_XML_TAG = /(?:authorization|credential|password|secret|servicekey|token)/i;
const SAFE_RESULT_CODE = /^[A-Za-z0-9._-]{1,32}$/;
const MAX_XML_TAG_LENGTH = 40;
const MAX_XML_DEPTH = 32;
const MAX_XML_SCALAR_LENGTH = 512;

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
  const formEncodedServiceKey = new URLSearchParams({ serviceKey }).toString().slice("serviceKey=".length);
  for (const value of [serviceKey, encodeURIComponent(serviceKey), formEncodedServiceKey]) {
    if (value) {
      message = message.replaceAll(value, "[REDACTED]");
    }
  }
  return message
    .replace(/(^|[?&])(serviceKey=)[^&\s]+/gi, "$1$2[REDACTED]")
    .replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function safeContentType(response) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  return contentType && ALLOWED_CONTENT_TYPES.has(contentType) ? contentType : SAFE_PLACEHOLDER;
}

function xmlScanDepth(state) {
  return state.openTags.length + state.overflowDepth;
}

function skipXmlSection(raw, start, terminator) {
  const end = raw.indexOf(terminator, start);
  return end === -1 ? raw.length : end + terminator.length;
}

function findXmlTagEnd(raw, start) {
  let quote = null;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return raw.length - 1;
}

function skipXmlSpecialSection(raw, index) {
  if (raw.startsWith("<!--", index)) return skipXmlSection(raw, index + 4, "-->");
  if (raw.startsWith("<![CDATA[", index)) return skipXmlSection(raw, index + 9, "]]>");
  if (raw.startsWith("<?", index)) return skipXmlSection(raw, index + 2, "?>");
  if (raw.startsWith("<!", index)) return findXmlTagEnd(raw, index + 2) + 1;
  return null;
}

function readXmlTagToken(raw, index) {
  let cursor = index + 1;
  const closing = raw[cursor] === "/";
  if (closing) cursor += 1;
  while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
  const nameStart = cursor;
  while (cursor < raw.length && !/[\s/>]/.test(raw[cursor])) cursor += 1;
  const nameLength = cursor - nameStart;
  if (nameLength === 0) return null;

  const name = nameLength <= MAX_XML_TAG_LENGTH ? raw.slice(nameStart, nameStart + nameLength) : null;
  const end = findXmlTagEnd(raw, cursor);
  let beforeEnd = end - 1;
  while (beforeEnd > cursor && /\s/.test(raw[beforeEnd])) beforeEnd -= 1;
  return {
    closing,
    name,
    nextIndex: end + 1,
    normalizedName: name?.toLowerCase() ?? SAFE_PLACEHOLDER,
    selfClosing: raw[beforeEnd] === "/",
  };
}

function appendXmlScalarText(raw, index, state) {
  const nextTag = raw.indexOf("<", index);
  const textEnd = nextTag === -1 ? raw.length : nextTag;
  if (state.scalar?.text.length < MAX_XML_SCALAR_LENGTH && xmlScanDepth(state) === state.scalar.depth) {
    const remaining = MAX_XML_SCALAR_LENGTH - state.scalar.text.length;
    state.scalar.text += raw.slice(index, Math.min(textEnd, index + remaining));
  }
  return textEnd;
}

function finishXmlScalar(state) {
  const value = state.scalar.text.trim();
  if (state.scalar.name === "resultcode") state.resultCode = value;
  if (state.scalar.name === "resultmsg") state.resultMessage = value;
  state.scalar = null;
}

function closeXmlTag(state, token) {
  if (state.scalar && token.normalizedName === state.scalar.name && xmlScanDepth(state) === state.scalar.depth) {
    finishXmlScalar(state);
  }
  if (state.overflowDepth > 0) {
    state.overflowDepth -= 1;
  } else if (state.openTags.at(-1) === token.normalizedName) {
    state.openTags.pop();
  }
}

function safeXmlTagName(name) {
  if (name && SAFE_XML_TAG.test(name) && !SENSITIVE_XML_TAG.test(name)) return name;
  return SAFE_PLACEHOLDER;
}

function recordXmlOpening(state, token) {
  if (state.scalar) return;
  const safeName = safeXmlTagName(token.name);
  if (!state.seen.has(safeName) && state.tags.length < 16) {
    state.seen.add(safeName);
    state.tags.push(safeName);
  }
  if (token.normalizedName === "item") state.itemCount += 1;
}

function isEnvelopeScalar(state, normalizedName) {
  if (state.scalar || state.openTags.length !== 2 || state.overflowDepth !== 0) return false;
  if (state.openTags[0] !== "root" || state.openTags[1] !== "header") return false;
  if (normalizedName === "resultcode") return state.resultCode == null;
  if (normalizedName === "resultmsg") return state.resultMessage == null;
  return false;
}

function openXmlTag(state, token) {
  recordXmlOpening(state, token);
  const capturesEnvelopeScalar = isEnvelopeScalar(state, token.normalizedName);
  if (token.selfClosing) {
    if (capturesEnvelopeScalar) {
      state.scalar = { name: token.normalizedName, depth: xmlScanDepth(state), text: "" };
      finishXmlScalar(state);
    }
    return;
  }

  if (state.openTags.length < MAX_XML_DEPTH) {
    state.openTags.push(token.normalizedName);
  } else {
    state.overflowDepth += 1;
  }
  if (capturesEnvelopeScalar) {
    state.scalar = { name: token.normalizedName, depth: xmlScanDepth(state), text: "" };
  }
}

function scanXmlStructure(raw) {
  const state = {
    tags: [],
    seen: new Set(),
    openTags: [],
    overflowDepth: 0,
    itemCount: 0,
    resultCode: null,
    resultMessage: null,
    scalar: null,
  };

  for (let index = 0; index < raw.length;) {
    if (raw[index] !== "<") {
      index = appendXmlScalarText(raw, index, state);
      continue;
    }
    const specialSectionEnd = skipXmlSpecialSection(raw, index);
    if (specialSectionEnd != null) {
      index = specialSectionEnd;
      continue;
    }
    const token = readXmlTagToken(raw, index);
    if (!token) {
      index += 1;
      continue;
    }
    if (token.closing) closeXmlTag(state, token);
    else openXmlTag(state, token);
    index = token.nextIndex;
  }

  return {
    itemCount: state.itemCount,
    resultCode: state.resultCode,
    resultMessage: state.resultMessage,
    tagSummary: state.tags.length > 0 ? state.tags.join(",") : MISSING_PLACEHOLDER,
  };
}

function classifyXmlFailure({ itemCount, resultCode, resultMessage }) {
  const classificationText = `${resultCode ?? ""} ${resultMessage ?? ""}`;
  if (/(?:authorization|auth(?:entication)?|service\s*key|api\s*key|서비스\s*키|인증|권한|등록되지\s*않)/i.test(classificationText)) {
    return "authorization";
  }
  if (/(?:invalid[\s_-]*(?:parameter|param|request)|parameter|param|파라미터|매개변수|요청\s*(?:값|변수).*잘못)/i.test(classificationText)) {
    return "invalid-parameter";
  }
  if (/(?:no[\s_-]*data|데이터.*없|결과.*없|조회.*없)/i.test(classificationText)) {
    return "no-data";
  }
  if (itemCount === 0 && /^(?:0+|ok|success)$/i.test(resultCode ?? "")) {
    return "no-data";
  }
  return itemCount > 0 ? "parser-shape" : "unknown";
}

function kricXmlDiagnostic(response, requestedFormat, raw) {
  const { itemCount, resultCode, resultMessage, tagSummary } = scanXmlStructure(raw);
  let safeResultCode = MISSING_PLACEHOLDER;
  if (resultCode != null && SAFE_RESULT_CODE.test(resultCode)) {
    safeResultCode = resultCode;
  } else if (resultCode != null) {
    safeResultCode = SAFE_PLACEHOLDER;
  }
  const httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
    ? response.status
    : SAFE_PLACEHOLDER;
  const classification = classifyXmlFailure({ itemCount, resultCode, resultMessage });
  return [
    "KRIC XML diagnostic:",
    `httpStatus=${httpStatus}`,
    `contentType=${safeContentType(response)}`,
    `requestedFormat=${requestedFormat}`,
    `xmlTags=${tagSummary}`,
    `itemCount=${itemCount}`,
    `resultCode=${safeResultCode}`,
    `classification=${classification}`,
  ].join(" ");
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
    const rawResponse = await response.text();
    await writeFile(rawPath, rawResponse, { mode: 0o600 });

    let sample;
    try {
      ({ stdout: sample } = await runEvidenceTool("build-source-candidate-sample-evidence.mjs", [
        "--candidate", candidateId,
        "--candidates", CANDIDATES_PATH,
        "--response", rawPath,
        "--format", request.format,
      ]));
    } catch (error) {
      if (request.format === "xml") {
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${kricXmlDiagnostic(response, request.format, rawResponse)}`);
      }
      throw error;
    }
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
