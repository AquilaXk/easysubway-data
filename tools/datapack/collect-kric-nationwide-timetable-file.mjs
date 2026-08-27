#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const KRIC_NATIONWIDE_TIMETABLE_FILE_URL = "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=900&operation=1";
export const DEFAULT_MAXIMUM_BYTES = 128 * 1024 * 1024;

const SOURCE_ID = "kric-nationwide-timetable-file";
const OUTPUT_PREFIX = "kric-nationwide-timetable-file-";
const XLSX_CONTENT_TYPE = /^(?:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/octet-stream)(?:\s*;|$)/iu;
const XLSX_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export async function collectKricNationwideTimetableFile({
  outputDirectory, fetchImpl = fetch, maximumBytes = DEFAULT_MAXIMUM_BYTES, now = new Date(),
} = {}) {
  const maximum = positiveSafeInteger(maximumBytes, "maximumBytes");
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
  const declaredLength = validateResponse(response, maximum);
  const bytes = await readBoundedBody(response.body, maximum);
  validateXlsxBytes(bytes, declaredLength);

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

function validateResponse(response, maximumBytes) {
  if (!response || response.status !== 200 || response.ok !== true) fail("HTTP");
  if (response.redirected === true) fail("REDIRECT");
  if (typeof response.url === "string" && response.url !== "" && new URL(response.url).origin !== new URL(KRIC_NATIONWIDE_TIMETABLE_FILE_URL).origin) {
    fail("REDIRECT");
  }
  const headers = response.headers;
  if (!XLSX_CONTENT_TYPE.test(headers?.get("content-type") ?? "")) fail("CONTENT_TYPE");
  if ((headers?.get("content-range") ?? "") !== "") fail("PARTIAL");
  const value = headers?.get("content-length");
  if (value === null || value === "") return null;
  if (!/^[1-9]\d*$/u.test(value)) fail("PARTIAL");
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximumBytes) fail("BODY");
  return length;
}

async function readBoundedBody(body, maximumBytes) {
  if (!body || typeof body.getReader !== "function") fail("BODY");
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      if (!(value instanceof Uint8Array)) fail("BODY");
      total += value.byteLength;
      if (total > maximumBytes) {
        try { await reader.cancel(); } catch { /* cleanup is best effort */ }
        fail("BODY");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.message === "KRIC_TIMETABLE_FILE_BODY") throw error;
    fail("BODY");
  }
}

function validateXlsxBytes(bytes, declaredLength) {
  if (declaredLength !== null && declaredLength !== bytes.length) fail("PARTIAL");
  if (bytes.length < 22 || !bytes.subarray(0, 4).equals(XLSX_SIGNATURE) || !hasRequiredXlsxEntries(bytes)) fail("BODY");
}

function hasRequiredXlsxEntries(bytes) {
  let eocd = -1;
  const start = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= start; index -= 1) {
    if (bytes[index] !== 0x50 || bytes[index + 1] !== 0x4b || bytes[index + 2] !== 0x05 || bytes[index + 3] !== 0x06) continue;
    const commentLength = bytes.readUInt16LE(index + 20);
    if (index + 22 + commentLength === bytes.length) { eocd = index; break; }
  }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) return false;
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (entryCount < 2 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralSize === 0xffffffff
    || centralOffset === 0xffffffff || centralOffset + centralSize !== eocd) return false;
  const names = new Set();
  let parsedEntryCount = 0;
  let offset = centralOffset;
  while (offset < eocd) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) return false;
    const flags = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x0001) !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff || end > eocd || localOffset + 30 > centralOffset
      || bytes.readUInt32LE(localOffset) !== 0x04034b50) return false;
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (localOffset + 30 + localNameLength + localExtraLength > centralOffset
      || localNameLength !== nameLength || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(name)) return false;
    names.add(name.toString("utf8"));
    parsedEntryCount += 1;
    offset = end;
  }
  return offset === eocd && parsedEntryCount === entryCount && names.has("[Content_Types].xml") && names.has("xl/workbook.xml");
}

async function publishAtomically({ bytes, output, parent, receipt }) {
  let staging;
  try {
    staging = await mkdtemp(path.join(parent, ".kric-nationwide-timetable-file-"));
    await writeFile(path.join(staging, "nationwide-timetable.xlsx"), bytes, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(staging, "receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    await outputRemainAbsent(output);
    await rename(staging, output);
    staging = undefined;
  } catch {
    fail("OUTPUT");
  } finally {
    if (staging !== undefined) {
      try { await rm(staging, { force: true, recursive: true }); } catch { /* output error is already stable */ }
    }
  }
}

async function outputRemainAbsent(value) {
  try { await lstat(value); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("output appeared during publish");
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

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`KRIC_TIMETABLE_FILE_${label.toUpperCase()}_INVALID`);
  return value;
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
