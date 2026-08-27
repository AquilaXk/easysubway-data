#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const KRIC_NATIONWIDE_TIMETABLE_FILE_URL = "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=900&operation=1";

const SOURCE_ID = "kric-nationwide-timetable-file";
const OUTPUT_PREFIX = "kric-nationwide-timetable-file-";
const XLSX_CONTENT_TYPE = /^(?:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/octet-stream)(?:\s*;|$)/iu;
const XLSX_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export async function collectKricNationwideTimetableFile({ outputDirectory, fetchImpl = fetch, now = new Date() } = {}) {
  const output = requiredTaskOutputDirectory(outputDirectory);
  const parent = path.dirname(output);
  await assertRegularDirectory(parent, "output parent");
  await assertAbsent(output);

  let response;
  try {
    response = await fetchImpl(KRIC_NATIONWIDE_TIMETABLE_FILE_URL, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("TRANSPORT");
  }
  validateResponse(response);
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    fail("BODY");
  }
  validateXlsxBytes(bytes, response.headers);

  const receipt = Object.freeze({
    schemaVersion: 1,
    artifactKind: "kric-nationwide-timetable-file-receipt",
    sourceId: SOURCE_ID,
    capturedAt: canonicalInstant(now),
    rawFile: "nationwide-timetable.xlsx",
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    credentialRedacted: true,
  });
  await publishAtomically({ bytes, output, parent, receipt });
  return receipt;
}

function validateResponse(response) {
  if (!response || response.status !== 200 || response.ok !== true) fail("HTTP");
  if (response.redirected === true) fail("REDIRECT");
  if (typeof response.url === "string" && response.url !== "" && new URL(response.url).origin !== new URL(KRIC_NATIONWIDE_TIMETABLE_FILE_URL).origin) {
    fail("REDIRECT");
  }
  const headers = response.headers;
  if (!XLSX_CONTENT_TYPE.test(headers?.get("content-type") ?? "")) fail("CONTENT_TYPE");
  if ((headers?.get("content-range") ?? "") !== "") fail("PARTIAL");
}

function validateXlsxBytes(bytes, headers) {
  const contentLength = headers?.get("content-length");
  if (contentLength !== null && contentLength !== "" && (!/^[1-9]\d*$/u.test(contentLength) || Number(contentLength) !== bytes.length)) fail("PARTIAL");
  if (bytes.length < 22 || !bytes.subarray(0, 4).equals(XLSX_SIGNATURE) || !hasZipEndOfCentralDirectory(bytes)) fail("BODY");
}

function hasZipEndOfCentralDirectory(bytes) {
  const start = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= start; index -= 1) {
    if (bytes[index] !== 0x50 || bytes[index + 1] !== 0x4b || bytes[index + 2] !== 0x05 || bytes[index + 3] !== 0x06) continue;
    const commentLength = bytes.readUInt16LE(index + 20);
    return index + 22 + commentLength === bytes.length;
  }
  return false;
}

async function publishAtomically({ bytes, output, parent, receipt }) {
  const staging = await mkdtemp(path.join(parent, ".kric-nationwide-timetable-file-"));
  try {
    await writeFile(path.join(staging, "nationwide-timetable.xlsx"), bytes, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(staging, "receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    await assertAbsent(output);
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

function requiredTaskOutputDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("OUTPUT");
  const output = path.resolve(value);
  if (!path.basename(output).startsWith(OUTPUT_PREFIX)) fail("OUTPUT");
  return output;
}

async function assertRegularDirectory(value, label) {
  let entry;
  try { entry = await lstat(value); } catch { fail("OUTPUT"); }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`KRIC_TIMETABLE_FILE_${label.toUpperCase().replaceAll(" ", "_")}_INVALID`);
}

async function assertAbsent(value) {
  try { await lstat(value); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  fail("OUTPUT_EXISTS");
}

function canonicalInstant(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("CLOCK");
  return value.toISOString();
}

function fail(code) { throw new Error(`KRIC_TIMETABLE_FILE_${code}`); }

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--output-dir") fail("ARGUMENT");
  return { outputDirectory: argv[1] };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectKricNationwideTimetableFile(parseArgs(process.argv.slice(2))).then(
    (receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
  );
}
