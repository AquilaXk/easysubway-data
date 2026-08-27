#!/usr/bin/env node
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

export const KRIC_NATIONWIDE_TIMETABLE_FILE_URL = "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=900&operation=1";
export const KRIC_CURRENT_STATION_LINE_FILE_URL = "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=1294&operation=1";
export const DEFAULT_MAXIMUM_BYTES = 128 * 1024 * 1024;

const TIMETABLE_PROFILE = Object.freeze({
  receiptArtifactKind: "kric-nationwide-timetable-file-receipt",
  sourceId: "kric-nationwide-timetable-file",
  outputPrefix: "kric-nationwide-timetable-file-",
  url: KRIC_NATIONWIDE_TIMETABLE_FILE_URL,
});
const CURRENT_STATION_LINE_PROFILE = Object.freeze({
  receiptArtifactKind: "kric-current-station-line-file-receipt",
  sourceId: "kric-current-station-line-file",
  outputPrefix: "kric-current-station-line-file-",
  url: KRIC_CURRENT_STATION_LINE_FILE_URL,
});
const XLSX_CONTENT_TYPE = /^(?:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/octet-stream)(?:\s*;|$)/iu;
const XLSX_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const STATION_LINE_SHEET = "1.역사정보";
const STATION_LINE_HEADER = ["철도운영기관명", "운영노선", "역 종류", "역 번호", "역명(한글)", "역명(영어)", "역명(로마자)", "역명(일본어)", "역명(중국어간체)", "역명(중국어번체)", "역명(부역명)", "환승역 여부", "환승노선명", "유실물 취급여부", "안전발판 유무", "스크린도어 설치유무", "승강장 연결여부", "승강장 유형", "역 위치(경도)", "역 위치(위도)", "역 주소(지번주소)", "역 주소(도로명 주소)", "역사 전화번호", "신설일자", "폐지일자", "상행거리", "하행거리", "데이터 기준일자", "참고사항"];
const REQUIRED_STATION_LINE_FIELDS = ["철도운영기관명", "운영노선", "역 번호", "역명(한글)"];
const MAX_STATION_LINE_COLUMNS = STATION_LINE_HEADER.length;
const MAX_STATION_LINE_ROWS = 1_109;
const MAX_STATION_LINE_CELLS = MAX_STATION_LINE_ROWS * MAX_STATION_LINE_COLUMNS;

export function parseKricCurrentStationLineWorkbook(bytes, { maximumInflatedBytes = DEFAULT_MAXIMUM_BYTES } = {}) {
  const entries = xlsxEntries(Buffer.from(bytes), positiveSafeInteger(maximumInflatedBytes, "maximumInflatedBytes"));
  const strings = xlsxSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8");
  const relationships = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!workbook || !relationships) throw new Error("KRIC_TIMETABLE_FILE_WORKBOOK");
  const sheet = xlsxSheetRefs(workbook, relationships).find((entry) => entry.name === STATION_LINE_SHEET);
  if (!sheet || !entries.has(sheet.entry)) throw new Error("KRIC_TIMETABLE_FILE_WORKSHEET");
  const rows = xlsxRows(entries.get(sheet.entry).toString("utf8"), strings);
  if (rows.length < 2 || !sameTextArray(rows[0], STATION_LINE_HEADER)) fail("HEADER");
  const indexes = REQUIRED_STATION_LINE_FIELDS.map((name) => rows[0].indexOf(name));
  if (indexes.some((index) => index < 0) || new Set(indexes).size !== indexes.length
    || REQUIRED_STATION_LINE_FIELDS.some((name) => rows[0].filter((value) => value === name).length !== 1)) fail("HEADER");
  return rows.slice(1).map((row, index) => ({
    operator: requiredWorkbookText(row[indexes[0]], index + 2),
    line: requiredWorkbookText(row[indexes[1]], index + 2),
    stationCode: requiredWorkbookText(row[indexes[2]], index + 2),
    stationName: requiredWorkbookText(row[indexes[3]], index + 2),
  }));
}

export async function collectKricNationwideTimetableFile({
  outputFile, fetchImpl = fetch, maximumBytes = DEFAULT_MAXIMUM_BYTES, now = new Date(), beforePublish = async () => {},
} = {}) {
  return collectKricFile({
    profile: TIMETABLE_PROFILE, outputFile, fetchImpl, maximumBytes, now, beforePublish,
  });
}

export async function collectKricCurrentStationLineFile({
  outputFile, fetchImpl = fetch, maximumBytes = DEFAULT_MAXIMUM_BYTES, now = new Date(), beforePublish = async () => {},
} = {}) {
  return collectKricFile({
    profile: CURRENT_STATION_LINE_PROFILE, outputFile, fetchImpl, maximumBytes, now, beforePublish,
  });
}

async function collectKricFile({
  profile, outputFile, fetchImpl, maximumBytes, now, beforePublish,
}) {
  const maximum = positiveSafeInteger(maximumBytes, "maximumBytes");
  const output = requiredTaskOutputFile(outputFile, profile.outputPrefix);
  const parent = path.dirname(output);
  const parentIdentity = await assertRegularDirectory(parent, "output parent");
  await assertAbsent(output);

  let response;
  try {
    response = await fetchImpl(profile.url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000), headers: { "accept-encoding": "identity" },
    });
  } catch {
    fail("TRANSPORT");
  }
  const declaredLength = validateResponse(response, maximum, profile.url);
  const bytes = await readBoundedBody(response.body, maximum);
  validateXlsxBytes(bytes, declaredLength);

  const receipt = Object.freeze({
    schemaVersion: 1,
    artifactKind: profile.receiptArtifactKind,
    sourceId: profile.sourceId,
    capturedAt: canonicalInstant(now),
    rawFile: path.basename(output),
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    credentialRedacted: true,
  });
  await publishAtomically({ beforePublish, bytes, output, parent, parentIdentity });
  return receipt;
}

function validateResponse(response, maximumBytes, expectedUrl) {
  if (!response || response.status !== 200 || response.ok !== true) fail("HTTP");
  if (response.redirected === true) fail("REDIRECT");
  if (typeof response.url === "string" && response.url !== "" && new URL(response.url).origin !== new URL(expectedUrl).origin) {
    fail("REDIRECT");
  }
  const headers = response.headers;
  if (!XLSX_CONTENT_TYPE.test(headers?.get("content-type") ?? "")) fail("CONTENT_TYPE");
  if ((headers?.get("content-range") ?? "") !== "") fail("PARTIAL");
  const value = headers?.get("content-length");
  if (value === null || value === "") return null;
  if (!/^[1-9]\d*$/u.test(value)) fail("PARTIAL");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) fail("BODY");
  const contentEncoding = (headers?.get("content-encoding") ?? "").trim().toLowerCase();
  if (contentEncoding !== "" && contentEncoding !== "identity") return null;
  if (length > maximumBytes) fail("BODY");
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

function xlsxEntries(bytes, maximumInflatedBytes) {
  const entries = new Map();
  let offset = 0;
  let inflatedBytes = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if ((flags & 0x0009) !== 0) fail("WORKBOOK");
    const start = offset + 30 + nameLength + extraLength;
    const end = start + compressedSize;
    if (end > bytes.length) fail("WORKBOOK");
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const compressed = bytes.subarray(start, end);
    let value;
    try {
      const remaining = maximumInflatedBytes - inflatedBytes;
      value = inflateXlsxEntry(compressed, method, remaining);
    } catch { value = null; }
    if (value == null || value.length > maximumInflatedBytes - inflatedBytes || entries.has(name)) fail("WORKBOOK");
    entries.set(name, value);
    inflatedBytes += value.length;
    offset = end;
  }
  return entries;
}

function inflateXlsxEntry(compressed, method, maximumOutputLength) {
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) return inflateRawSync(compressed, { maxOutputLength: maximumOutputLength });
  return null;
}

function xlsxSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map(([, item]) =>
    [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(([, value]) => decodeXml(value)).join(""),
  );
}

function xlsxSheetRefs(workbook, relationshipsXml) {
  const relationships = new Map([...relationshipsXml.matchAll(/<Relationship\b([^>]*)>/gi)].map(([, raw]) => {
    const attributes = xmlAttributes(raw);
    return [attributes.Id, attributes.Target];
  }));
  return [...workbook.matchAll(/<sheet\b([^>]*)>/gi)].map(([, raw]) => {
    const attributes = xmlAttributes(raw);
    const target = relationships.get(attributes["r:id"]);
    if (!attributes.name || !/^worksheets\/sheet\d+\.xml$/u.test(target ?? "")) fail("WORKSHEET");
    return { name: attributes.name, entry: `xl/${target}` };
  });
}

function xlsxRows(xml, strings) {
  const rows = [];
  let cellCount = 0;
  for (const [, body] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    if (rows.length >= MAX_STATION_LINE_ROWS) fail("WORKSHEET");
    const parsed = xlsxRow(body, strings, cellCount);
    rows.push(parsed.row);
    cellCount = parsed.cellCount;
  }
  return rows;
}

function xlsxRow(body, strings, initialCellCount) {
  const row = new Array(MAX_STATION_LINE_COLUMNS).fill("");
  const populatedColumns = new Set();
  let cellCount = initialCellCount;
  for (const [, raw, value] of body.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    if (cellCount >= MAX_STATION_LINE_CELLS) fail("WORKSHEET");
    const attributes = xmlAttributes(raw);
    const column = xlsxColumn(attributes.r);
    if (column >= MAX_STATION_LINE_COLUMNS || populatedColumns.has(column)) fail("WORKSHEET");
    const cell = xlsxCell(attributes.t, value, strings);
    if (cell == null) fail("WORKBOOK");
    populatedColumns.add(column);
    row[column] = cell;
    cellCount += 1;
  }
  return { row, cellCount };
}

function xlsxCell(type, value, strings) {
  const rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(value)?.[1] ?? "";
  if (type === "inlineStr") {
    return [...value.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
      .map(([, text]) => decodeXml(text)).join("");
  }
  if (type === "s") return strings[Number(rawValue)];
  return decodeXml(rawValue);
}

function xlsxColumn(reference) {
  const letters = /^([A-Z]{1,3})\d+$/iu.exec(reference ?? "")?.[1];
  if (!letters) fail("WORKBOOK");
  return [...letters].reduce((value, letter) => value * 26 + letter.codePointAt(0) - 64, 0) - 1;
}

function xmlAttributes(raw) {
  return Object.fromEntries([...raw.matchAll(/(?:^|\s)([:\w-]+)\s*=\s*"([^"]*)"/gu)]
    .map(([, name, value]) => [name, decodeXml(value)]));
}

function decodeXml(value) {
  return String(value).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function requiredWorkbookText(value, row) {
  const normalized = String(value ?? "").normalize("NFC").trim();
  if (normalized === "") throw new Error(`KRIC_TIMETABLE_FILE_ROW_${row}`);
  return normalized;
}

function sameTextArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

async function publishAtomically({ beforePublish, bytes, output, parent, parentIdentity }) {
  let stagingFile;
  let stagingDirectory;
  try {
    stagingDirectory = await mkdtemp(path.join(parent, ".kric-nationwide-timetable-file-"));
    stagingFile = path.join(stagingDirectory, "nationwide-timetable.xlsx");
    await writeFile(stagingFile, bytes, { flag: "wx", mode: 0o600 });
    await beforePublish();
    await assertSameRegularDirectory(parent, "output parent", parentIdentity);
    await link(stagingFile, output);
    stagingFile = undefined;
  } catch {
    fail("OUTPUT");
  } finally {
    if (stagingDirectory !== undefined) {
      try { await rm(stagingDirectory, { force: true, recursive: true }); } catch { /* output error is already stable */ }
    }
  }
}

function requiredTaskOutputFile(value, outputPrefix) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("OUTPUT");
  const output = path.resolve(value);
  if (!path.basename(output).startsWith(outputPrefix) || path.extname(output) !== ".xlsx") fail("OUTPUT");
  return output;
}

async function assertRegularDirectory(value, label) {
  let entry;
  try { entry = await lstat(value); } catch { fail("OUTPUT"); }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`KRIC_TIMETABLE_FILE_${label.toUpperCase().replaceAll(" ", "_")}_INVALID`);
  const target = await stat(value);
  if (!target.isDirectory() || target.dev !== entry.dev || target.ino !== entry.ino) fail("OUTPUT");
  return { dev: target.dev, ino: target.ino };
}

async function assertSameRegularDirectory(value, label, expected) {
  const actual = await assertRegularDirectory(value, label);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail("OUTPUT");
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
  if (!Array.isArray(argv) || (argv.length !== 2 && argv.length !== 4)) fail("ARGUMENT");
  if (argv.length === 2 && argv[0] === "--output-file") return { profile: "timetable", outputFile: argv[1] };
  if (argv.length === 4 && argv[0] === "--profile" && argv[2] === "--output-file"
    && ["timetable", "current-station-line"].includes(argv[1])) return { profile: argv[1], outputFile: argv[3] };
  fail("ARGUMENT");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const collect = args.profile === "current-station-line" ? collectKricCurrentStationLineFile : collectKricNationwideTimetableFile;
  try {
    const receipt = await collect({ outputFile: args.outputFile });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
