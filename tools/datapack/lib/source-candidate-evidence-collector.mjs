// #1701: collect-kric-source-candidate-evidence.mjs와 collect-datago-source-candidate-evidence.mjs가 공유하는 XML 안전 파서·sanitize·수집 파이프라인.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  classifyProviderFailure,
  formatProviderFailureEvidence,
  requiresControlOperation,
} from "./provider-call-integrity.mjs";

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
export const MAX_ERROR_BODY_LENGTH = 64 * 1024;

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

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function appendJsonChildren(pending, value) {
  for (const child of Object.values(value)) {
    if (pending.length === 128) return;
    if (child && typeof child === "object") pending.push(child);
  }
}

function findJsonFailureEnvelope(payload) {
  const pending = [payload];
  for (let cursor = 0; cursor < pending.length && cursor < 128; cursor += 1) {
    const value = pending[cursor];
    if (!value || typeof value !== "object") continue;
    if (!Array.isArray(value) && Object.hasOwn(value, "resultCode")
      && !/^(?:0+|ok|success)$/i.test(String(value.resultCode))) {
      return value;
    }
    appendJsonChildren(pending, value);
  }
  return null;
}

function jsonResultCode(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return String(value);
}

function safeResultCode(resultCode) {
  if (resultCode == null) return MISSING_PLACEHOLDER;
  if (SAFE_RESULT_CODE.test(resultCode)) return resultCode;
  return SAFE_PLACEHOLDER;
}

export function buildJsonDiagnostic({ response, raw, label }) {
  const envelope = findJsonFailureEnvelope(parseJson(raw));
  if (!envelope) return null;
  const resultCode = jsonResultCode(envelope.resultCode);
  const resultMessage = typeof envelope.resultMsg === "string" ? envelope.resultMsg : null;
  const httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
    ? response.status
    : SAFE_PLACEHOLDER;
  return [
    label.replace("XML", "JSON"),
    `httpStatus=${httpStatus}`,
    `resultCode=${safeResultCode(resultCode)}`,
    `classification=${classifyXmlFailure({ itemCount: 0, resultCode, resultMessage })}`,
  ].join(" ");
}

function safeHttpStatus(response) {
  const status = response?.status;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

// #22: provider가 돌려준 실패 신호. 키 훼손과 권한 미보유가 같은 코드로 오기 때문에 신호만으로 판정하지 않는다.
function providerResponseSignal({ raw, format }) {
  if (raw == null) return { providerResultCode: null, providerResultSignal: null };
  if (format === "json") {
    const envelope = findJsonFailureEnvelope(parseJson(raw));
    if (!envelope) return { providerResultCode: null, providerResultSignal: null };
    const resultCode = jsonResultCode(envelope.resultCode);
    const resultMessage = typeof envelope.resultMsg === "string" ? envelope.resultMsg : null;
    return {
      providerResultCode: resultCode,
      providerResultSignal: classifyXmlFailure({ itemCount: 0, resultCode, resultMessage }),
    };
  }
  const { itemCount, resultCode, resultMessage } = scanXmlStructure(raw);
  return {
    providerResultCode: resultCode,
    providerResultSignal: classifyXmlFailure({ itemCount, resultCode, resultMessage }),
  };
}

// 필드 이름만 있고 값이 비어 있는 row는 대조군 성공으로 세지 않는다.
// 자리표시자만 담긴 게이트웨이 응답이 대조군을 통과하면 잘못된 blocker를 증거로 뒷받침한다.
function hasRequiredControlFields(value, requiredFields) {
  return requiredFields.every((field) => {
    if (!Object.hasOwn(value, field)) return false;
    const fieldValue = value[field];
    if (fieldValue == null || typeof fieldValue === "object") return false;
    return typeof fieldValue !== "string" || fieldValue.trim() !== "";
  });
}

function hasXmlFieldValue(fragment, field) {
  const match = new RegExp(String.raw`<${field}(?:\s[^>]*)?>([\s\S]*?)</${field}>`).exec(fragment);
  if (match == null) return false;
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1").trim() !== "";
}

function countJsonControlRows(payload, requiredFields) {
  const pending = [payload];
  let rows = 0;
  for (let cursor = 0; cursor < pending.length && cursor < 128; cursor += 1) {
    const value = pending[cursor];
    if (!value || typeof value !== "object") continue;
    if (!Array.isArray(value) && hasRequiredControlFields(value, requiredFields)) {
      rows += 1;
      continue;
    }
    appendJsonChildren(pending, value);
  }
  return rows;
}

// provider가 크기를 정하는 XML이므로 응답 전체를 물질화하지 않는다. limit을 채우면 즉시 멈춘다.
export function countXmlControlRows(raw, requiredFields, limit) {
  let qualifying = 0;
  for (const [, fragment] of raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    if (!requiredFields.every((field) => hasXmlFieldValue(fragment, field))) continue;
    qualifying += 1;
    if (qualifying >= limit) break;
  }
  return qualifying;
}

// 대조군은 "실패가 아님"이 아니라 카탈로그가 선언한 "기대 성공 형태"를 충족해야 성공이다.
// 그렇지 않으면 빈 응답이나 게이트웨이 오류 페이지가 대조군을 통과해 잘못된 blocker를 증거로 뒷받침한다.
function controlOperationSucceeded(raw, format, expectedSuccess) {
  const { minimumRowCount, requiredFields } = expectedSuccess;
  if (format === "json") {
    const payload = parseJson(raw);
    if (payload == null || findJsonFailureEnvelope(payload) != null) return false;
    return countJsonControlRows(payload, requiredFields) >= minimumRowCount;
  }
  // KRIC XML 성공 응답에는 header가 없을 수 있다(성공 경로가 그 형태를 그대로 받는다).
  // 명시적 실패 코드만 거부하고, 코드가 없으면 필수 행이 성공을 증명하게 한다.
  const resultCode = scanXmlStructure(raw).resultCode;
  if (resultCode != null && !/^(?:0+|ok|success)$/i.test(resultCode)) return false;
  return countXmlControlRows(raw, requiredFields, minimumRowCount) >= minimumRowCount;
}

// 같은 실행·같은 키로 카탈로그가 지정한 대조군을 호출한다. 실패는 어떤 이유든 "failed"로 닫는다.
async function runControlOperation({ controlOperation, serviceKey, fetchImpl }) {
  try {
    const url = new URL(controlOperation.sampleUrl);
    url.searchParams.set("serviceKey", serviceKey);
    const response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: controlOperation.format === "json" ? "application/json" : "application/xml,text/xml",
      },
    });
    if (!response.ok) return "failed";
    return controlOperationSucceeded(
      await response.text(),
      controlOperation.format,
      controlOperation.expectedSuccess,
    ) ? "succeeded" : "failed";
  } catch {
    return "failed";
  }
}

// 대상 operation이 곧 대조군이면 그 호출은 독립 대조가 아니라 같은 operation의 재시도다.
// 성공을 그대로 인정하면 방금 접근 가능함이 증명된 operation에 권한 미보유 판정이 나온다.
async function resolveControlOperationStatus({ controlOperation, candidateId, serviceKey, fetchImpl }) {
  const status = await runControlOperation({ controlOperation, serviceKey, fetchImpl });
  return status === "succeeded" && controlOperation.candidateId === candidateId ? "self-succeeded" : status;
}

async function providerFailureEvidence({ controlOperation, candidateId, serviceKey, fetchImpl, response, raw, format }) {
  if (!controlOperation) return "";
  const httpStatus = safeHttpStatus(response);
  const { providerResultCode, providerResultSignal } = providerResponseSignal({ raw, format });
  const controlOperationStatus = requiresControlOperation({ httpStatus, providerResultSignal })
    ? await resolveControlOperationStatus({ controlOperation, candidateId, serviceKey, fetchImpl })
    : "not-run";
  const diagnosis = classifyProviderFailure({
    httpStatus,
    providerResultCode,
    providerResultSignal,
    controlOperationStatus,
  });
  return ` ${formatProviderFailureEvidence(diagnosis)}`;
}

// provider 응답을 입력으로 삼는 실패에 분류를 붙인다. 근거가 비어 있으면(=provider 계약 미선언)
// 원래 오류를 그대로 올려 기존 redaction 동작을 바꾸지 않는다.
async function classifiedProviderError(error, { failureEvidence, response, raw, format }) {
  const evidence = await failureEvidence({ response, raw, format });
  if (!evidence) return error;
  return new Error(`${error instanceof Error ? error.message : String(error)}${evidence}`);
}

// non-ok 응답 본문에는 provider result code가 실린다. 본문 읽기 실패가 새 예외 경로가 되지 않도록
// 방어적으로 읽고, 못 읽으면 null로 낮춘다 — status 기반 판정은 유지되고, 근거가 빈 승격은
// assertProviderBlockerPromotable이 이미 거부한다. 스캔·보관 분량은 provider가 정하지 못하도록 상한을 둔다.
async function readErrorResponseBody(response) {
  try {
    const raw = await response.text();
    return raw.length > MAX_ERROR_BODY_LENGTH ? raw.slice(0, MAX_ERROR_BODY_LENGTH) : raw;
  } catch {
    return null;
  }
}

// provider 요청과 body 수신. 이 구간의 실패는 전부 분류를 달고 나간다.
async function readProviderResponse({ request, serviceKey, fetchImpl, failureEvidence, requestFailureLabel }) {
  const liveUrl = new URL(request.sampleUrl);
  liveUrl.searchParams.set("serviceKey", serviceKey);
  const transportEvidence = { failureEvidence, response: null, raw: null, format: request.format };

  let response;
  try {
    response = await fetchImpl(liveUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: request.format === "json" ? "application/json" : "application/xml,text/xml" },
    });
  } catch (error) {
    // DNS·TLS·redirect 거부·timeout은 응답 분기 전에 reject된다. 분류 없이 빠져나가지 않게 근거를 붙인다.
    throw await classifiedProviderError(error, transportEvidence);
  }
  if (!response.ok) {
    // 401·403은 credential 신호로 지원한다고 선언한 경로다. 본문을 버리면 provider result code가 사라져
    // 대조군이 성공해도 blocker 승격에 필요한 근거를 만들 수 없다.
    const errorBody = await readErrorResponseBody(response);
    const { providerResultCode } = providerResponseSignal({ raw: errorBody, format: request.format });
    const evidence = await failureEvidence({ response, raw: errorBody, format: request.format });
    throw new Error(`${requestFailureLabel} ${response.status} resultCode=${safeResultCode(providerResultCode)}${evidence}`);
  }
  try {
    // body 스트림이 끊기면 응답을 받지 못한 것과 같다. HTTP status를 근거로 쓰지 않고 전송 실패로 닫는다.
    return { response, rawResponse: await response.text() };
  } catch (error) {
    throw await classifiedProviderError(error, transportEvidence);
  }
}

async function assertNoJsonDiagnostic({ request, response, rawResponse, diagnosticLabel, failureEvidence }) {
  if (request.format !== "json") return;
  const diagnostic = buildJsonDiagnostic({ response, raw: rawResponse, label: diagnosticLabel });
  if (diagnostic) {
    throw new Error(`${diagnostic}${await failureEvidence({ response, raw: rawResponse, format: request.format })}`);
  }
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
  controlOperation = null,
} = {}) {
  requiredText(serviceKey, serviceKeyLabel);
  const failureEvidence = ({ response, raw, format }) =>
    providerFailureEvidence({ controlOperation, candidateId, serviceKey, fetchImpl, response, raw, format });
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

    const { response, rawResponse } = await readProviderResponse({
      request,
      serviceKey,
      fetchImpl,
      failureEvidence,
      requestFailureLabel,
    });
    await writeFile(rawPath, rawResponse, { mode: 0o600 });
    await assertNoJsonDiagnostic({ request, response, rawResponse, diagnosticLabel, failureEvidence });

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
        const diagnostic = buildXmlDiagnostic({ response, requestedFormat: request.format, raw: rawResponse, label: diagnosticLabel });
        const evidence = await failureEvidence({ response, raw: rawResponse, format: request.format });
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${diagnostic}${evidence}`);
      }
      throw await classifiedProviderError(error, {
        failureEvidence,
        response,
        raw: rawResponse,
        format: request.format,
      });
    }

    let report;
    try {
      JSON.parse(sample);
      await writeFile(stagedSamplePath, sample, { mode: 0o600 });
      ({ stdout: report } = await runEvidenceTool(validateScriptName, [
        "--candidate", candidateId,
        "--candidates", candidatesPath,
        "--sample", stagedSamplePath,
      ]));
    } catch (error) {
      throw await classifiedProviderError(error, {
        failureEvidence,
        response,
        raw: rawResponse,
        format: request.format,
      });
    }
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
