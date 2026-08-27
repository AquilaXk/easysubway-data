import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { crc32, createInflateRaw } from "node:zlib";

import { codepointCompare } from "../lib/codepoint-compare.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";
const RECEIPT_KIND = "kric-nationwide-timetable-file-receipt";
const OBSERVATION_KIND = "kric-nationwide-timetable-observation";
const OUTPUT_PREFIX = "kric-nationwide-timetable-file-";
const SHEET_NAME = "표준데이터 운행(전체)";
const HEADER = ["열차번호", "노선번호", "노선명", "운행구간기점명", "운행구간종점명", "운행유형", "요일구분", "운행구간정거장", "정거장도착시각", "정가장출발시각", "운행속도", "운영기관전화번호", "데이터기준일자"];
const GROUP_FIELDS = ["trainNumber", "routeNumber", "routeName", "originStationName", "destinationStationName", "serviceType", "weekdayType"];
const IDENTITY_FIELDS = [...GROUP_FIELDS, "stationName"];
const OBSERVATION_FIELDS = ["arrivalTime", "departureTime", "speed", "operatorPhone", "dataReferenceDate"];
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_INPUT_BYTES = 128 * 1024 * 1024;
const MAXIMUM_INFLATED_BYTES = 192 * 1024 * 1024;
const MAXIMUM_ROWS = 300_000;
const MAXIMUM_CELLS = 4_800_000;
const MAXIMUM_ROW_BYTES = 128 * 1024;
const MAXIMUM_CELL_TEXT = 32 * 1024;
const MAXIMUM_SHARED_STRINGS = 500_000;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(`KRIC_NATIONWIDE_TIMETABLE_OBSERVATION_${code}`); };

// This producer is deliberately source-native evidence. It never derives a
// timetable, topology, route order, or product identifier from these cells.
export async function buildKricNationwideTimetableObservation({
  inputFile, workbookBytes, receipt, maximumInputBytes = MAXIMUM_INPUT_BYTES,
  maximumInflatedBytes = MAXIMUM_INFLATED_BYTES, maximumRows = MAXIMUM_ROWS,
  maximumCells = MAXIMUM_CELLS, maximumRowBytes = MAXIMUM_ROW_BYTES,
} = {}) {
  const limits = validateLimits({ maximumInputBytes, maximumInflatedBytes, maximumRows, maximumCells, maximumRowBytes });
  const source = workbookBytes === undefined
    ? await openRegularWorkbook(inputFile, limits.maximumInputBytes)
    : requireWorkbookBytes(inputFile, workbookBytes, limits.maximumInputBytes);
  const verifiedReceipt = validateReceipt(receipt, source);
  const entries = parseZipEntries(source.bytes, limits.maximumInflatedBytes);
  const workbook = await readEntryText(source.bytes, "xl/workbook.xml", entries, 1_024 * 1_024);
  const relationships = await readEntryText(source.bytes, "xl/_rels/workbook.xml.rels", entries, 1_024 * 1_024);
  const sheetEntry = await resolveExactWorksheet(workbook, relationships, entries);
  const styleCount = await readStyleCount(source.bytes, entries);
  const sharedStrings = await readSharedStrings(source.bytes, entries);
  const state = await parseWorksheet({ bytes: source.bytes, entry: sheetEntry, entries, sharedStrings, styleCount, limits });
  if (!sameTextArray(state.header, HEADER)) fail("HEADER");
  if (state.records.length === 0) fail("WORKSHEET");
  state.records.sort(compareRecords);
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: OBSERVATION_KIND,
    sourceId: SOURCE_ID,
    observedAt: verifiedReceipt.capturedAt,
    rawFile: verifiedReceipt.rawFile,
    rawByteLength: source.byteLength,
    rawSha256: source.sha256,
    rowCount: state.records.length,
    groupCount: state.groups.size,
    records: state.records,
    recordsSha256: sha256(Buffer.from(`${JSON.stringify(state.records)}\n`)),
    gaps: Object.freeze({ stopSequence: "ABSENT", timeGrammar: "UNADMITTED" }),
  });
}

function requireWorkbookBytes(inputFile, value, maximumInputBytes) {
  if (typeof inputFile !== "string" || !path.isAbsolute(inputFile) || !(value instanceof Uint8Array)
    || value.byteLength <= 0 || value.byteLength > maximumInputBytes) fail("INPUT");
  const bytes = Buffer.from(value);
  return Object.freeze({ inputFile: path.resolve(inputFile), byteLength: bytes.length, sha256: sha256(bytes), bytes });
}

async function openRegularWorkbook(inputFile, maximumInputBytes) {
  if (typeof inputFile !== "string" || !path.isAbsolute(inputFile)) fail("INPUT");
  const resolved = path.resolve(inputFile);
  let entry;
  try { entry = await lstat(resolved); } catch { fail("INPUT"); }
  if (!entry.isFile() || entry.isSymbolicLink()) fail("INPUT");
  let handle;
  try {
    handle = await open(resolved, "r");
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino || current.size <= 0 || current.size > maximumInputBytes) fail("INPUT");
    const bytes = Buffer.alloc(current.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== current.size) fail("INPUT");
    return Object.freeze({ inputFile: resolved, byteLength: bytes.length, sha256: sha256(bytes), bytes });
  } catch (error) {
    if (error?.message?.startsWith("KRIC_NATIONWIDE_TIMETABLE_OBSERVATION_")) throw error;
    fail("INPUT");
  } finally { await handle?.close(); }
}

function validateReceipt(receiptInput, source) {
  let receipt = receiptInput;
  if (typeof receipt === "string") {
    try { receipt = JSON.parse(receipt); } catch { fail("RECEIPT"); }
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== RECEIPT_KIND || receipt.sourceId !== SOURCE_ID
    || !canonicalInstant(receipt.capturedAt) || typeof receipt.rawFile !== "string"
    || path.basename(receipt.rawFile) !== receipt.rawFile
    || !new RegExp(`^${OUTPUT_PREFIX}[^/]+\\.xlsx$`, "u").test(receipt.rawFile)
    || !Number.isSafeInteger(receipt.byteLength) || receipt.byteLength <= 0
    || typeof receipt.sha256 !== "string" || !SHA256.test(receipt.sha256) || receipt.credentialRedacted !== true) fail("RECEIPT");
  if (receipt.rawFile !== path.basename(source.inputFile) || receipt.byteLength !== source.byteLength || receipt.sha256 !== source.sha256) fail("CONTENT_DRIFT");
  return Object.freeze({ capturedAt: receipt.capturedAt, rawFile: receipt.rawFile });
}

function parseZipEntries(bytes, maximumInflatedBytes) {
  if (bytes.length < 22 || !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) fail("ZIP");
  let end = -1;
  for (let index = bytes.length - 22, min = Math.max(0, bytes.length - 65_557); index >= min; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) fail("ZIP");
  const count = bytes.readUInt16LE(end + 10); const size = bytes.readUInt32LE(end + 12); let offset = bytes.readUInt32LE(end + 16);
  if (count === 0 || count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size !== end) fail("ZIP");
  const entries = new Map(); let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail("ZIP");
    const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10); const crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20); const inflated = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28); const extra = bytes.readUInt16LE(offset + 30); const comment = bytes.readUInt16LE(offset + 32); const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extra + comment;
    if ((flags & 0x0009) !== 0 || ![0, 8].includes(method) || compressed === 0xffffffff || inflated === 0xffffffff || localOffset === 0xffffffff || next > end) fail("ZIP");
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (!safeEntryName(name) || entries.has(name) || localOffset + 30 > offset || bytes.readUInt32LE(localOffset) !== 0x04034b50) fail("ZIP");
    const localNameLength = bytes.readUInt16LE(localOffset + 26); const localExtra = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtra;
    if (bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method
      || bytes.readUInt32LE(localOffset + 14) !== crc
      || bytes.readUInt32LE(localOffset + 18) !== compressed || bytes.readUInt32LE(localOffset + 22) !== inflated
      || dataOffset + compressed > offset || localNameLength !== nameLength
      || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(Buffer.from(name))) fail("ZIP");
    total += inflated;
    if (total > maximumInflatedBytes) fail("BOUND");
    entries.set(name, Object.freeze({ compressed, crc32: crc, dataOffset, inflated, method })); offset = next;
  }
  if (offset !== end || !entries.has("xl/workbook.xml") || !entries.has("xl/_rels/workbook.xml.rels")) fail("ZIP");
  return entries;
}

function safeEntryName(name) { return /^[A-Za-z0-9_[\]./-]+$/u.test(name) && !name.startsWith("/") && !name.includes("../") && !name.endsWith("/"); }

async function resolveExactWorksheet(workbook, relationships, entries) {
  const relationshipMap = new Map([...relationships.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/giu)].map(([, raw]) => {
    const attributes = xmlAttributes(raw); return [attributes.Id, attributes.Target];
  }));
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/giu)].map(([, raw]) => xmlAttributes(raw));
  if (sheets.length !== 1 || sheets[0].name !== SHEET_NAME) fail("SHEET");
  const target = relationshipMap.get(sheets[0]["r:id"]);
  if (typeof target !== "string" || !/^worksheets\/sheet\d+\.xml$/u.test(target)) fail("SHEET");
  const entry = `xl/${target}`;
  if (!entries.has(entry)) fail("SHEET");
  return entry;
}

async function readStyleCount(bytes, entries) {
  if (!entries.has("xl/styles.xml")) return 0;
  const styles = await readEntryText(bytes, "xl/styles.xml", entries, 2 * 1024 * 1024);
  const match = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/iu.exec(styles);
  if (!match) fail("STYLE");
  const count = [...match[1].matchAll(/<xf\b[^>]*\/?>(?:<\/xf>)?/giu)].length;
  if (count === 0) fail("STYLE");
  return count;
}

async function readSharedStrings(bytes, entries) {
  if (!entries.has("xl/sharedStrings.xml")) return [];
  const result = []; let carry = "";
  await streamEntry(bytes, "xl/sharedStrings.xml", entries, async (chunk) => {
    carry += chunk;
    while (true) {
      const end = carry.indexOf("</si>");
      if (end < 0) break;
      const item = carry.slice(0, end + 5); carry = carry.slice(end + 5);
      const start = item.indexOf("<si");
      if (start < 0) continue;
      if (result.length >= MAXIMUM_SHARED_STRINGS) fail("BOUND");
      const value = [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)].map(([, text]) => decodeXml(text)).join("");
      if (Buffer.byteLength(value) > MAXIMUM_CELL_TEXT) fail("BOUND");
      result.push(value);
    }
    if (Buffer.byteLength(carry) > MAXIMUM_CELL_TEXT * 2) fail("BOUND");
  });
  if (!/^\s*<\?xml[\s\S]*?<sst\b/iu.test(carry) && result.length === 0) fail("SHARED_STRING");
  return result;
}

async function parseWorksheet({ bytes, entry, entries, sharedStrings, styleCount, limits }) {
  const state = { header: null, records: [], groups: new Set(), cells: 0, rows: 0, carry: "", unsafeTail: "" };
  await streamEntry(bytes, entry, entries, async (chunk) => {
    const unsafe = state.unsafeTail + chunk;
    if (/<mergeCell\b|<f\b/iu.test(unsafe)) fail(/<mergeCell\b/iu.test(unsafe) ? "MERGED" : "FORMULA");
    state.unsafeTail = unsafe.slice(-32);
    state.carry += chunk;
    if (Buffer.byteLength(state.carry) > limits.maximumRowBytes + 32 * 1024) fail("BOUND");
    let end;
    while ((end = state.carry.indexOf("</row>")) >= 0) {
      const rowXml = state.carry.slice(0, end + 6); state.carry = state.carry.slice(end + 6);
      const rowStart = rowXml.indexOf("<row");
      if (rowStart < 0) continue;
      if (state.rows >= limits.maximumRows) fail("BOUND");
      const row = parseRow(rowXml.slice(rowStart), sharedStrings, styleCount, state, limits.maximumCells);
      state.rows += 1;
      if (state.header === null) {
        if (row.sourceRowNumber !== 1 || row.values.slice(13).some((cell) => cell.value !== "")) fail("HEADER");
        state.header = row.values.slice(0, HEADER.length).map((cell) => cell.value);
        continue;
      }
      addRecord(row, state);
    }
  });
  if (state.carry.trim() !== "" && /<row\b/iu.test(state.carry)) fail("WORKSHEET");
  return state;
}

function parseRow(xml, sharedStrings, styleCount, state, maximumCells) {
  const rowAttributes = xmlAttributes(/^<row\b([^>]*)>/iu.exec(xml)?.[1] ?? "");
  const sourceRowNumber = Number(rowAttributes.r);
  if (!Number.isSafeInteger(sourceRowNumber) || sourceRowNumber <= 0) fail("WORKSHEET");
  const values = Array.from({ length: 15 }, () => ({ value: "", cellType: "inlineStr", styleId: null })); const columns = new Set();
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/giu)) {
    if (state.cells >= maximumCells) fail("BOUND");
    const attributes = xmlAttributes(match[1]); const column = columnIndex(attributes.r, sourceRowNumber);
    if (column > 14 || columns.has(column)) fail("COLUMN");
    const cell = parseCell(attributes, match[2] ?? "", sharedStrings, styleCount);
    columns.add(column); values[column] = cell; state.cells += 1;
  }
  return { sourceRowNumber, values };
}

function parseCell(attributes, body, sharedStrings, styleCount) {
  if (/<f\b/iu.test(body)) fail("FORMULA");
  const type = attributes.t ?? "n"; const styleId = attributes.s === undefined ? null : Number(attributes.s);
  if (!Number.isSafeInteger(styleId ?? 0) || (styleId !== null && (styleId < 0 || styleId >= styleCount))) fail("STYLE");
  let value;
  if (type === "inlineStr") value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)].map(([, text]) => decodeXml(text)).join("");
  else if (type === "s") { const index = Number(/^\s*<v\b[^>]*>([\s\S]*?)<\/v>\s*$/iu.exec(body)?.[1]); if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) fail("SHARED_STRING"); value = sharedStrings[index]; }
  else if (["n", "str", "b", "e", "d"].includes(type)) value = decodeXml(/<v\b[^>]*>([\s\S]*?)<\/v>/iu.exec(body)?.[1] ?? "");
  else fail("CELL");
  if (Buffer.byteLength(value) > MAXIMUM_CELL_TEXT) fail("BOUND");
  return Object.freeze({ value, cellType: type, styleId });
}

function addRecord(row, state) {
  const cells = row.values;
  if (cells.slice(13).some((cell) => cell.value !== "")) fail("COLUMN");
  const identity = cells.slice(0, 8).map((cell) => normalized(cell.value, "REQUIRED"));
  state.groups.add(JSON.stringify(identity.slice(0, 7)));
  const record = Object.fromEntries(IDENTITY_FIELDS.map((field, index) => [field, identity[index]]));
  for (const [index, field] of OBSERVATION_FIELDS.entries()) record[field] = cells[index + 8];
  record.sourceRowNumber = row.sourceRowNumber;
  record.sourceRowSha256 = sha256(JSON.stringify({ ...record }));
  state.records.push(Object.freeze(record));
}

async function readEntryText(bytes, entry, entries, maximumBytes) {
  let result = "";
  await streamEntry(bytes, entry, entries, async (chunk) => { result += chunk; if (Buffer.byteLength(result) > maximumBytes) fail("BOUND"); });
  return result;
}

async function streamEntry(bytes, entry, entries, consume) {
  const metadata = entries.get(entry); if (!metadata) fail("ZIP");
  const compressed = bytes.subarray(metadata.dataOffset, metadata.dataOffset + metadata.compressed);
  const source = Readable.from([compressed]);
  const stream = metadata.method === 8 ? source.pipe(createInflateRaw()) : source;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let consumed = 0; let checksum = 0;
  try {
    for await (const chunk of stream) {
      consumed += chunk.length;
      if (consumed > metadata.inflated) fail("ZIP");
      checksum = crc32(chunk, checksum);
      const text = decoder.decode(chunk, { stream: true });
      if (text !== "") await consume(text);
    }
    const tail = decoder.decode();
    if (tail !== "") await consume(tail);
  } catch (error) {
    stream.destroy();
    if (error?.message?.startsWith("KRIC_NATIONWIDE_TIMETABLE_OBSERVATION_")) throw error;
    fail("ZIP");
  }
  if (consumed !== metadata.inflated || checksum !== metadata.crc32) fail("ZIP");
}

function validateLimits(limits) { for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) fail("BOUND"); return limits; }
function canonicalInstant(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value; }
function normalized(value, code) { const result = String(value ?? "").normalize("NFC").trim(); if (result === "") fail(code); return result; }
function columnIndex(reference, rowNumber) { const match = /^([A-Z]{1,3})(\d+)$/u.exec(reference ?? ""); if (!match || Number(match[2]) !== rowNumber) fail("COLUMN"); return [...match[1]].reduce((sum, letter) => sum * 26 + letter.codePointAt(0) - 64, 0) - 1; }
function compareRecords(left, right) { for (const field of [...IDENTITY_FIELDS]) { const comparison = codepointCompare(left[field], right[field]); if (comparison !== 0) return comparison; } return left.sourceRowNumber - right.sourceRowNumber; }
function sameTextArray(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]); }
function xmlAttributes(raw) { return Object.fromEntries([...String(raw).matchAll(/(?:^|\s)([:\w-]+)\s*=\s*"([^"]*)"/gu)].map(([, name, value]) => [name, decodeXml(value)])); }
function decodeXml(value) { return String(value).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&"); }
