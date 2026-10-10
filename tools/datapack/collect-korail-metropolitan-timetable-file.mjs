#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMainModule } from "../lib/is-main-module.mjs";
import { isTransientStatus, unwrapTransientRetryFailure, withTransientRetry } from "./lib/transient-retry.mjs";

export const REQUEST_TIMEOUT_MS = 30_000;
export const MAXIMUM_BYTES = 128 * 1024 * 1024;
export const KORAIL_METROPOLITAN_TIMETABLE_FILE_SOURCE_ID = "korail-metropolitan-timetable-file";

const URL_PREFIX = "/file/cubedata/COMMON/jfile/";
const XLSX_CONTENT_TYPE = /^(?:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/octet-stream)(?:\s*;|$)/iu;
const XLSX_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function validateKorailTimetableFileReceipt(receipt, { rawSha256, rawByteLength }) {
  if (receipt?.schemaVersion !== 1 || receipt.artifactKind !== "korail-metropolitan-timetable-file-receipt"
    || receipt.sourceId !== KORAIL_METROPOLITAN_TIMETABLE_FILE_SOURCE_ID
    || receipt.rawFile !== "timetable.xlsx" || receipt.credentialRedacted !== true
    || receipt.sha256 !== rawSha256 || receipt.byteLength !== rawByteLength
    || !Number.isSafeInteger(rawByteLength) || rawByteLength < 4
    || typeof receipt.capturedAt !== "string" || !Number.isFinite(Date.parse(receipt.capturedAt))
    || new Date(receipt.capturedAt).toISOString() !== receipt.capturedAt) fail("RECEIPT");
  sha256(rawSha256);
  officialKorailUrl(receipt.officialUrl);
  return structuredClone(receipt);
}

export async function collectKorailMetropolitanTimetableFile({ url, expectedSha256, outputDirectory, fetchImpl = fetch, sleepImpl, retryBudget } = {}) {
  const officialUrl = officialKorailUrl(url);
  const expected = sha256(expectedSha256);
  const output = absoluteOutputDirectory(outputDirectory);
  try { await mkdir(output); } catch { fail("OUTPUT_DIRECTORY"); }
  const bytes = await downloadWithTransientRetry(fetchImpl, officialUrl, { sleepImpl, retryBudget });
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(XLSX_SIGNATURE)) fail("XLSX");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected) fail("SHA256");
  const receipt = {
    schemaVersion: 1,
    artifactKind: "korail-metropolitan-timetable-file-receipt",
    sourceId: KORAIL_METROPOLITAN_TIMETABLE_FILE_SOURCE_ID,
    capturedAt: new Date().toISOString(),
    rawFile: "timetable.xlsx",
    byteLength: bytes.length,
    sha256: digest,
    officialUrl,
    credentialRedacted: true,
  };
  try {
    await writeFile(path.join(output, receipt.rawFile), bytes, { flag: "wx" });
    await writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt), { flag: "wx" });
  } catch { fail("OUTPUT"); }
  return receipt;
}

// 요청과 본문 읽기를 한 번의 시도로 묶어 일시 오류(HTTP 408·5xx, 연결·요청·본문 timeout, 소켓 끊김)면 같은 요청을 다시 보낸다(#1099).
// 인증·형식·내용 오류는 재시도하지 않는다. 한도를 다 쓰면 기존 오류 코드(HTTP·TRANSPORT·BODY)로 실패한다.
async function downloadWithTransientRetry(fetchImpl, officialUrl, { sleepImpl, retryBudget }) {
  let outcome;
  try {
    outcome = await withTransientRetry(async () => {
      let response;
      try {
        response = await fetchImpl(officialUrl, { method: "GET", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        throw Object.assign(new Error("KORAIL_METROPOLITAN_TIMETABLE_FILE_TRANSPORT"), { cause: error });
      }
      if (isTransientStatus(response?.status)) {
        try { await response.body?.cancel(); } catch { /* best effort */ }
        return { response, bytes: null };
      }
      validateResponse(response);
      return { response, bytes: await readBounded(response.body) };
    }, { isTransientResult: ({ bytes }) => bytes === null, sleep: sleepImpl, budget: retryBudget });
  } catch (error) {
    throw unwrapTransientRetryFailure(error);
  }
  if (outcome.bytes === null) validateResponse(outcome.response);
  return outcome.bytes;
}

function officialKorailUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail("URL"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.korail.com" || parsed.port !== ""
    || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== ""
    || !parsed.pathname.startsWith(URL_PREFIX) || !parsed.pathname.endsWith(".xlsx")) fail("URL");
  return parsed.href;
}

function sha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("SHA256");
  return value;
}

function absoluteOutputDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("OUTPUT_DIRECTORY");
  return value;
}

function validateResponse(response) {
  if (!response || response.status !== 200 || response.ok !== true || response.redirected === true) fail("HTTP");
  if (!XLSX_CONTENT_TYPE.test(response.headers?.get("content-type") ?? "")) fail("CONTENT_TYPE");
}

async function readBounded(body) {
  if (!body || typeof body.getReader !== "function") fail("BODY");
  const reader = body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      if (!(value instanceof Uint8Array) || (total += value.byteLength) > MAXIMUM_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        fail("BODY");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.message === "KORAIL_METROPOLITAN_TIMETABLE_FILE_BODY") throw error;
    // 원인을 남겨 재시도 정책이 본문 수신 중 timeout·연결 끊김을 알아볼 수 있게 한다. 메시지는 기존 코드 그대로다.
    throw Object.assign(new Error("KORAIL_METROPOLITAN_TIMETABLE_FILE_BODY"), { cause: error });
  }
}

function fail(code) { throw new Error(`KORAIL_METROPOLITAN_TIMETABLE_FILE_${code}`); }

function cliArguments(argv) {
  if (argv.length !== 6) fail("ARGUMENTS");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!["--url", "--sha256", "--output-directory"].includes(argv[index]) || values.has(argv[index])) fail("ARGUMENTS");
    values.set(argv[index], argv[index + 1]);
  }
  return { url: values.get("--url"), expectedSha256: values.get("--sha256"), outputDirectory: values.get("--output-directory") };
}

if (isMainModule(import.meta.url)) {
  Promise.resolve().then(() => collectKorailMetropolitanTimetableFile(cliArguments(process.argv.slice(2))))
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
