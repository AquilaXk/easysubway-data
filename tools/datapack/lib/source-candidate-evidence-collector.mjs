// #1701: collect-kric-source-candidate-evidence.mjs와 collect-datago-source-candidate-evidence.mjs가 공유하는 XML 안전 파서·sanitize·수집 파이프라인.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const libDir = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_DIRECTORY = path.resolve(libDir, "..");
export const REPOSITORY_ROOT = path.resolve(libDir, "../../..");
export const CANDIDATES_PATH = path.join(TOOL_DIRECTORY, "source-candidates.json");

const execFileAsync = promisify(execFile);

export const SAFE_PLACEHOLDER = "[unsafe]";
export const MISSING_PLACEHOLDER = "[missing]";
export const ALLOWED_CONTENT_TYPES = new Set(["application/xml", "text/xml"]);
export const SAFE_XML_TAG = /^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/;
export const SENSITIVE_XML_TAG = /(?:authorization|credential|password|secret|servicekey|token)/i;
export const SAFE_RESULT_CODE = /^[A-Za-z0-9._-]{1,32}$/;
export const MAX_XML_TAG_LENGTH = 40;
export const MAX_XML_DEPTH = 32;
export const MAX_XML_SCALAR_LENGTH = 512;

export function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export function sanitizeErrorMessage(error, serviceKey) {
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

export function safeContentType(response) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  return contentType && ALLOWED_CONTENT_TYPES.has(contentType) ? contentType : SAFE_PLACEHOLDER;
}

export function xmlScanDepth(state) {
  return state.openTags.length + state.overflowDepth;
}

export function skipXmlSection(raw, start, terminator) {
  const end = raw.indexOf(terminator, start);
  return end === -1 ? raw.length : end + terminator.length;
}

export function findXmlTagEnd(raw, start) {
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

export function skipXmlSpecialSection(raw, index) {
  if (raw.startsWith("<!--", index)) return skipXmlSection(raw, index + 4, "-->");
  if (raw.startsWith("<![CDATA[", index)) return skipXmlSection(raw, index + 9, "]]>");
  if (raw.startsWith("<?", index)) return skipXmlSection(raw, index + 2, "?>");
  if (raw.startsWith("<!", index)) return findXmlTagEnd(raw, index + 2) + 1;
  return null;
}

export function readXmlTagToken(raw, index) {
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

export function appendXmlScalarText(raw, index, state) {
  const nextTag = raw.indexOf("<", index);
  const textEnd = nextTag === -1 ? raw.length : nextTag;
  if (state.scalar?.text.length < MAX_XML_SCALAR_LENGTH && xmlScanDepth(state) === state.scalar.depth) {
    const remaining = MAX_XML_SCALAR_LENGTH - state.scalar.text.length;
    state.scalar.text += raw.slice(index, Math.min(textEnd, index + remaining));
  }
  return textEnd;
}

export function finishXmlScalar(state) {
  const value = state.scalar.text.trim();
  if (state.scalar.name === "resultcode") state.resultCode = value;
  if (state.scalar.name === "resultmsg") state.resultMessage = value;
  state.scalar = null;
}

export function closeXmlTag(state, token) {
  if (state.scalar && token.normalizedName === state.scalar.name && xmlScanDepth(state) === state.scalar.depth) {
    finishXmlScalar(state);
  }
  if (state.overflowDepth > 0) {
    state.overflowDepth -= 1;
  } else if (state.openTags.at(-1) === token.normalizedName) {
    state.openTags.pop();
  }
}

export function safeXmlTagName(name) {
  if (name && SAFE_XML_TAG.test(name) && !SENSITIVE_XML_TAG.test(name)) return name;
  return SAFE_PLACEHOLDER;
}

export function recordXmlOpening(state, token) {
  if (state.scalar) return;
  const safeName = safeXmlTagName(token.name);
  if (!state.seen.has(safeName) && state.tags.length < 16) {
    state.seen.add(safeName);
    state.tags.push(safeName);
  }
  if (token.normalizedName === "item") state.itemCount += 1;
}

export function isEnvelopeScalar(state, normalizedName) {
  if (state.scalar || state.openTags.length !== 2 || state.overflowDepth !== 0) return false;
  if (state.openTags[0] !== "root" || state.openTags[1] !== "header") return false;
  if (normalizedName === "resultcode") return state.resultCode == null;
  if (normalizedName === "resultmsg") return state.resultMessage == null;
  return false;
}

export function openXmlTag(state, token) {
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

export function scanXmlStructure(raw) {
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

export function classifyXmlFailure({ itemCount, resultCode, resultMessage }) {
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

export function buildXmlDiagnostic({ response, requestedFormat, raw, label }) {
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
    label,
    `httpStatus=${httpStatus}`,
    `contentType=${safeContentType(response)}`,
    `requestedFormat=${requestedFormat}`,
    `xmlTags=${tagSummary}`,
    `itemCount=${itemCount}`,
    `resultCode=${safeResultCode}`,
    `classification=${classification}`,
  ].join(" ");
}

export async function runEvidenceTool(scriptName, args) {
  return execFileAsync(process.execPath, [path.join(TOOL_DIRECTORY, scriptName), ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function parseCli(argv, scriptName) {
  if (argv.length !== 2 || argv[0] !== "--candidate" || !argv[1] || argv[1].startsWith("--")) {
    throw new Error(`usage: ${scriptName} --candidate <fixed-candidate-id>`);
  }
  return { candidateId: argv[1] };
}

export async function collectSourceCandidateEvidence({
  candidateId,
  candidatesDocument,
  fetchImpl = fetch,
  runnerTemp,
  serviceKey,
  serviceKeyLabel,
  directoryPrefix,
  request,
  requestFailureLabel,
  diagnosticLabel,
  writeStagedCandidates = false,
  buildScriptName,
  validateScriptName,
} = {}) {
  requiredText(serviceKey, serviceKeyLabel);
  if (!path.isAbsolute(requiredText(runnerTemp, "RUNNER_TEMP"))) {
    throw new Error("RUNNER_TEMP must be an absolute path");
  }

  const outputDirectory = path.join(runnerTemp, `${directoryPrefix}-evidence`);
  const stagingDirectory = path.join(runnerTemp, `${directoryPrefix}-staging`);
  const rawDirectory = path.join(runnerTemp, `${directoryPrefix}-raw`);
  const rawPath = path.join(rawDirectory, `${candidateId}.response`);
  const stagedCandidatesPath = path.join(stagingDirectory, "source-candidates.json");
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
    let candidatesPath = CANDIDATES_PATH;
    if (writeStagedCandidates) {
      await writeFile(stagedCandidatesPath, `${JSON.stringify(candidatesDocument)}\n`, { mode: 0o600 });
      candidatesPath = stagedCandidatesPath;
    }

    const liveUrl = new URL(request.sampleUrl);
    liveUrl.searchParams.set("serviceKey", serviceKey);
    const response = await fetchImpl(liveUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: request.format === "json" ? "application/json" : "application/xml,text/xml" },
    });
    if (!response.ok) {
      throw new Error(`${requestFailureLabel} ${response.status}`);
    }
    const rawResponse = await response.text();
    await writeFile(rawPath, rawResponse, { mode: 0o600 });

    let sample;
    try {
      ({ stdout: sample } = await runEvidenceTool(buildScriptName, [
        "--candidate", candidateId,
        "--candidates", candidatesPath,
        "--response", rawPath,
        "--format", request.format,
      ]));
    } catch (error) {
      if (request.format === "xml") {
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${buildXmlDiagnostic({ response, requestedFormat: request.format, raw: rawResponse, label: diagnosticLabel })}`);
      }
      throw error;
    }
    JSON.parse(sample);
    await writeFile(stagedSamplePath, sample, { mode: 0o600 });

    const { stdout: report } = await runEvidenceTool(validateScriptName, [
      "--candidate", candidateId,
      "--candidates", candidatesPath,
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
