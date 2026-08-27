import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildKricNationwideTimetableObservation } from "./build-kric-nationwide-timetable-observation.mjs";

const HEADER = ["열차번호", "노선번호", "노선명", "운행구간기점명", "운행구간종점명", "운행유형", "요일구분", "운행구간정거장", "정거장도착시각", "정가장출발시각", "운행속도", "운영기관전화번호", "데이터기준일자"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(entries = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-timetable-observation-"));
  const bytes = workbook(entries);
  const inputFile = path.join(root, "kric-nationwide-timetable-file-test.xlsx");
  await writeFile(inputFile, bytes);
  return {
    root,
    inputFile,
    receipt: {
      schemaVersion: 1,
      artifactKind: "kric-nationwide-timetable-file-receipt",
      sourceId: "kric-nationwide-timetable-file",
      capturedAt: "2026-08-27T00:00:00.000Z",
      rawFile: path.basename(inputFile),
      byteLength: bytes.length,
      sha256: sha256(bytes),
      credentialRedacted: true,
    },
  };
}

test("#454 produces deterministic evidence-only observations and preserves mixed time cells", async () => {
  const value = await fixture({
    rows: [
      [" T2 ", "R", "노선", "A", "B", "일반", "평일", "역B", { value: "0.5", cellType: "n", styleId: 1 }, { value: "09:10", cellType: "inlineStr", styleId: 2 }, "", "", ""],
      ["T1", "R", "노선", "A", "B", "일반", "평일", "역A", { value: "08:00", cellType: "inlineStr", styleId: 2 }, "", "", "", "", "", ""],
    ],
  });
  try {
    const first = await buildKricNationwideTimetableObservation(value);
    const second = await buildKricNationwideTimetableObservation({ ...value, receipt: JSON.stringify(value.receipt) });
    assert.deepEqual(second, first);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.artifactKind, "kric-nationwide-timetable-observation");
    assert.equal(first.sourceId, value.receipt.sourceId);
    assert.equal(first.observedAt, value.receipt.capturedAt);
    assert.equal(first.rawFile, value.receipt.rawFile);
    assert.equal(first.rowCount, 2);
    assert.equal(first.groupCount, 2);
    assert.deepEqual(first.gaps, { stopSequence: "ABSENT", timeGrammar: "UNADMITTED" });
    assert.deepEqual(first.records.map((record) => record.stationName), ["역A", "역B"]);
    assert.deepEqual(first.records[1].arrivalTime, { value: "0.5", cellType: "n", styleId: 1 });
    assert.deepEqual(first.records[1].departureTime, { value: "09:10", cellType: "inlineStr", styleId: 2 });
    assert.deepEqual(first.records[0].departureTime, { value: "", cellType: "inlineStr", styleId: null });
    assert.equal(Object.hasOwn(first.records[0], "stopSequence"), false);
    assert.equal(Object.hasOwn(first.records[0], "stationId"), false);
    assert.equal(first.recordsSha256, sha256(Buffer.from(`${JSON.stringify(first.records)}\n`)));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("#454 rejects receipt and unsafe input bindings before parsing", async () => {
  const value = await fixture({ rows: [requiredRow()] });
  try {
    for (const [name, change, expected] of [
      ["receipt", (input) => { input.receipt.sha256 = "0".repeat(64); }, /KRIC_NATIONWIDE_TIMETABLE_OBSERVATION_CONTENT_DRIFT/],
      ["bad filename", (input) => { input.receipt.rawFile = "foreign.xlsx"; }, /KRIC_NATIONWIDE_TIMETABLE_OBSERVATION_RECEIPT/],
      ["relative file", (input) => { input.inputFile = path.basename(input.inputFile); }, /KRIC_NATIONWIDE_TIMETABLE_OBSERVATION_INPUT/],
    ]) {
      const input = structuredClone(value); change(input);
      await assert.rejects(buildKricNationwideTimetableObservation(input), expected, name);
    }
    const linked = path.join(value.root, "link.xlsx");
    await symlink(value.inputFile, linked);
    await assert.rejects(buildKricNationwideTimetableObservation({ ...value, inputFile: linked }), /KRIC_NATIONWIDE_TIMETABLE_OBSERVATION_INPUT/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("#454 fails closed for worksheet contract and forbidden data", async () => {
  const cases = [
    ["sheet", { sheetName: "other" }, /_SHEET/],
    ["extra sheet", { extraSheet: true }, /_SHEET/],
    ["header", { header: [...HEADER.slice(0, 12), "wrong"] }, /_HEADER/],
    ["header N/O", { header: [...HEADER, "unexpected", "unexpected"] }, /_HEADER/],
    ["formula", { rows: [[...requiredRow(), { formula: "SUM(1,1)" }]] }, /_FORMULA/],
    ["merged", { merged: true }, /_MERGED/],
    ["overflow", { rows: [[...requiredRow(), "", "bad"]] }, /_COLUMN/],
    ["blank required", { rows: [["", ...requiredRow().slice(1)]] }, /_REQUIRED/],
    ["bound", { rows: [requiredRow()], maximumRows: 1 }, /_BOUND/],
  ];
  for (const [name, options, expected] of cases) {
    const value = await fixture(options);
    try {
      await assert.rejects(buildKricNationwideTimetableObservation({ ...value, maximumRows: options.maximumRows }), expected, name);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test("#454 preserves duplicate source rows and blank time cells without admission", async () => {
  const row = [...requiredRow().slice(0, 8), "", ...requiredRow().slice(9)];
  const value = await fixture({ rows: [row, row] });
  try {
    const result = await buildKricNationwideTimetableObservation(value);
    assert.equal(result.rowCount, 2);
    assert.equal(result.groupCount, 1);
    assert.equal(result.records[0].arrivalTime.value, "");
    assert.equal(result.records[1].arrivalTime.value, "");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("#454 drains complete stored rows before bounding residual XML", async () => {
  const value = await fixture({ rows: Array.from({ length: 200 }, requiredRow) });
  try {
    const result = await buildKricNationwideTimetableObservation({
      ...value, maximumRowBytes: 2 * 1024,
    });
    assert.equal(result.rowCount, 200);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

function requiredRow() { return ["T1", "R", "노선", "A", "B", "일반", "평일", "역A", "08:00", "", "", "", ""]; }

function workbook({ rows = [requiredRow()], header = HEADER, sheetName = "표준데이터 운행(전체)", merged = false, extraSheet = false } = {}) {
  const sheetRows = [header, ...rows].map((row, rowNumber) => xmlRow(row, rowNumber + 1)).join("");
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData>${merged ? "<mergeCells count=\"1\"><mergeCell ref=\"A1:B1\"/></mergeCells>" : ""}</worksheet>`;
  return zip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="${sheetName}" r:id="rId1"/>${extraSheet ? "<sheet name=\"extra\" r:id=\"rId2\"/>" : ""}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>${extraSheet ? "<Relationship Id=\"rId2\" Target=\"worksheets/sheet2.xml\"/>" : ""}</Relationships>`,
    "xl/styles.xml": "<styleSheet><cellXfs count=\"3\"><xf/><xf/><xf/></cellXfs></styleSheet>",
    "xl/worksheets/sheet1.xml": sheet,
    ...(extraSheet ? { "xl/worksheets/sheet2.xml": "<worksheet><sheetData/></worksheet>" } : {}),
  });
}

function xmlRow(values, rowNumber) {
  return `<row r="${rowNumber}">${values.map((value, index) => xmlCell(value, `${column(index)}${rowNumber}`)).join("")}</row>`;
}

function xmlCell(value, reference) {
  if (value?.formula) return `<c r="${reference}"><f>${value.formula}</f><v>2</v></c>`;
  const cellType = value?.cellType ?? "inlineStr";
  const style = value?.styleId == null ? "" : ` s="${value.styleId}"`;
  const text = value?.value ?? value ?? "";
  if (cellType === "n") return `<c r="${reference}"${style}><v>${escape(text)}</v></c>`;
  return `<c r="${reference}"${style} t="${cellType}"><is><t>${escape(text)}</t></is></c>`;
}

function escape(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;"); }
function column(index) { let result = ""; for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) result = String.fromCharCode(65 + ((current - 1) % 26)) + result; return result; }

function zip(entries) {
  let offset = 0;
  const locals = Object.entries(entries).map(([name, content]) => {
    const filename = Buffer.from(name); const data = Buffer.from(content); const header = Buffer.alloc(30);
    const crc = crc32(data); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.concat([header, filename, data]); const record = { filename, data, crc, offset, entry }; offset += entry.length; return record;
  });
  const central = locals.map(({ filename, data, crc, offset: localOffset }) => { const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(localOffset, 42); return Buffer.concat([header, filename]); });
  const centralBytes = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(locals.length, 8); end.writeUInt16LE(locals.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals.map(({ entry }) => entry), centralBytes, end]);
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) { value ^= byte; for (let index = 0; index < 8; index += 1) value = (value >>> 1) ^ ((value & 1) * 0xedb88320); }
  return (value ^ 0xffffffff) >>> 0;
}
