import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KORAIL_FACILITY_WORKBOOK_URL,
  probeKorailFacilityWorkbook,
  readBoundedResponseBody,
  summarizeKorailWorkbook,
} from "./probe-korail-facility-workbook.mjs";

const XLSX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("fixture")]);

function response(body = XLSX_BYTES, url = KORAIL_FACILITY_WORKBOOK_URL) {
  const value = new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-msdownload" },
  });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

test("Korail FACILITY probe는 raw workbook을 삭제하고 sanitized identity만 기록한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "korail-facility-probe-test-"));
  const output = path.join(root, "evidence.json");
  try {
    const evidence = await probeKorailFacilityWorkbook({
      capturedAt: "2026-08-05T00:00:00.000Z",
      fetchImpl: async (url, options) => {
        assert.equal(String(url), KORAIL_FACILITY_WORKBOOK_URL);
        assert.equal(options.redirect, "error");
        return response();
      },
      inspectWorkbookImpl: async (input) => {
        assert.deepEqual(await readFile(input), XLSX_BYTES);
        return { sheets: [{
          name: "승강설비현황",
          leadingRows: [["운영기관", "노선", "역명"]],
          rowCount: 630,
        }] };
      },
      output,
      tempRoot: root,
    });

    assert.deepEqual(evidence, {
      schemaVersion: 1,
      artifactKind: "korail-facility-workbook-probe-evidence",
      sourceId: "korail-facility-workbook-2473",
      sourceUrl: KORAIL_FACILITY_WORKBOOK_URL,
      capturedAt: "2026-08-05T00:00:00.000Z",
      contentType: "application/x-msdownload",
      rawSha256: createHash("sha256").update(XLSX_BYTES).digest("hex"),
      byteCount: XLSX_BYTES.length,
      sheets: [{ name: "승강설비현황", leadingRows: [["운영기관", "노선", "역명"]], rowCount: 630 }],
    });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), evidence);
    assert.deepEqual(await readdir(root), ["evidence.json"]);
    assert.equal("admissionState" in evidence, false);
    assert.equal("matchedGaps" in evidence, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Korail FACILITY probe는 final URL origin drift를 거부한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "korail-facility-probe-invalid-"));
  try {
    await assert.rejects(() => probeKorailFacilityWorkbook({
      fetchImpl: async () => response(XLSX_BYTES, "https://example.com/file.xlsx"),
      inspectWorkbookImpl: async () => ({ sheets: [] }),
      output: path.join(root, "drift.json"),
      tempRoot: root,
    }), /final URL/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Korail FACILITY probe는 non-XLSX body를 거부한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "korail-facility-probe-signature-"));
  try {
    await assert.rejects(() => probeKorailFacilityWorkbook({
      fetchImpl: async () => response(Buffer.from("not a workbook")),
      inspectWorkbookImpl: async () => ({ sheets: [] }),
      output: path.join(root, "invalid.json"),
      tempRoot: root,
    }), /XLSX signature/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Korail FACILITY probe는 inspector 실패 뒤 raw workbook을 삭제한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "korail-facility-probe-cleanup-"));
  try {
    await assert.rejects(() => probeKorailFacilityWorkbook({
      fetchImpl: async () => response(),
      inspectWorkbookImpl: async (input) => {
        assert.deepEqual(await readFile(input), XLSX_BYTES);
        throw new Error("workbook parser failed");
      },
      output: path.join(root, "evidence.json"),
      tempRoot: root,
    }), /workbook parser failed/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded response reader는 byte limit 초과 body를 취소한다", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
    },
    cancel() {
      cancelled = true;
    },
  }));
  await assert.rejects(() => readBoundedResponseBody(response, 8), /exceeds byte limit/);
  assert.equal(cancelled, true);
});

test("Korail workbook summary는 기존 bounded XLSX parser로 leading rows와 row count를 복원한다", async () => {
  const entries = new Map([
    ["xl/workbook.xml", `<workbook xmlns:r="rels"><sheets><sheet name="승강설비현황" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<sst><si><t>운영기관</t></si><si><t>노선</t></si><si><t>역명</t></si></sst>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>한국철도공사</t></is></c><c r="B2" t="inlineStr"><is><t>경원선</t></is></c><c r="C2" t="inlineStr"><is><t>광운대역사</t></is></c></row>
    </sheetData></worksheet>`],
  ]);
  assert.deepEqual(await summarizeKorailWorkbook(async (entry, optional = false) => {
    if (entries.has(entry)) return entries.get(entry);
    if (optional) return "";
    throw new Error(`missing ${entry}`);
  }), {
    sheets: [{
      name: "승강설비현황",
      leadingRows: [
        ["운영기관", "노선", "역명"],
        ["한국철도공사", "경원선", "광운대역사"],
      ],
      rowCount: 2,
    }],
  });
});

test("Korail workbook summary는 leading rows를 10개로 제한한다", async () => {
  const rows = Array.from({ length: 11 }, (_, index) =>
    `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>row-${index + 1}</t></is></c></row>`).join("");
  const entries = new Map([
    ["xl/workbook.xml", `<workbook xmlns:r="rels"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", ""],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>${rows}</sheetData></worksheet>`],
  ]);
  const summary = await summarizeKorailWorkbook(async (entry) => entries.get(entry));
  assert.equal(summary.sheets[0].leadingRows.length, 10);
  assert.deepEqual(summary.sheets[0].leadingRows.at(-1), ["row-10"]);
  assert.equal(summary.sheets[0].rowCount, 11);
});

test("Korail workbook summary는 non-empty row가 없는 workbook을 거부한다", async () => {
  const entries = new Map([
    ["xl/workbook.xml", `<workbook xmlns:r="rels"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", ""],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"></row></sheetData></worksheet>`],
  ]);
  await assert.rejects(() => summarizeKorailWorkbook(async (entry) => entries.get(entry)), /contains no non-empty rows/);
});
