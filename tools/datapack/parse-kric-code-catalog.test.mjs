import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";

import {
  buildProviderLineCatalog,
  extractXlsxWorkbookEntries,
  parseSharedStrings,
  parseWorkbookSheetRefs,
  parseWorksheetRows,
} from "./parse-kric-code-catalog.mjs";

test("self-closing XLSX cells preserve empty columns and following values", () => {
  const rows = parseWorksheetRows(`<worksheet><sheetData><row r="1">
    <c r="A1" s="2"/><c r="B1"><v>0.25</v></c>
    <c r="C1"/><c r="D1" t="s"><v>0</v></c>
    <c r="E1"/><c r="F1" t="inlineStr"><is><t>station</t></is></c>
    <c r="G1"/>
  </row></sheetData></worksheet>`, ["train"]);
  assert.deepEqual(rows, [["", "0.25", "", "train", "", "station", ""]]);
});

test("KRIC XLSX workbook relation과 shared string을 bounded row로 복원한다", () => {
  const workbookXml = `<?xml version="1.0"?><workbook xmlns:r="rels"><sheets>
    <sheet name = "코드정보" sheetId="1" r:id = "rId1"/>
  </sheets></workbook>`;
  const relationshipsXml = `<?xml version="1.0"?><Relationships>
    <Relationship Id = "rId1" Target = "worksheets/sheet1.xml"/>
  </Relationships>`;
  assert.deepEqual(parseWorkbookSheetRefs(workbookXml, relationshipsXml), [{
    name: "코드정보",
    entry: "xl/worksheets/sheet1.xml",
  }]);

  const sharedStrings = parseSharedStrings(`<sst>
    <si><t>권역코드</t></si><si><t>노선코드</t></si><si><r><t>운영</t></r><r><t>기관</t></r></si>
  </sst>`);
  assert.deepEqual(sharedStrings, ["권역코드", "노선코드", "운영기관"]);

  const rows = parseWorksheetRows(`<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>01</t></is></c><c r="B2"><v>4</v></c><c r="C2" t="str"><v>S1</v></c></row>
  </sheetData></worksheet>`, sharedStrings);
  assert.deepEqual(rows, [
    ["권역코드", "노선코드", "운영기관"],
    ["01", "4", "S1"],
  ]);
});

test("KRIC station code rows는 중복 없는 provider-line catalog로 축약한다", () => {
  const catalog = buildProviderLineCatalog({
    sourceId: "kric-provider-code-catalog-20260228",
    sourceSha256: "a".repeat(64),
    capturedAt: "2026-07-19T00:00:00.000Z",
    sheets: [{ name: "Sheet1", rows: [
      ["RAIL_OPR_ISTT_CD", "RAIL_OPR_ISTT_NM", "LN_CD", "LN_NM", "STIN_CD", "STIN_NM"],
      ["S1", "서울교통공사", "4", "4호선", "433", "사당"],
      ["S1", "서울교통공사", "4", "4호선", "434", "총신대입구"],
      ["KR", "한국철도공사", "4", "4호선", "448", "상록수"],
    ] }],
  });
  assert.equal(catalog.stationRecordCount, 3);
  assert.deepEqual(catalog.providerLines, [
    { railOprIsttCd: "KR", operatorName: "한국철도공사", lnCd: "4", lineName: "4호선" },
    { railOprIsttCd: "S1", operatorName: "서울교통공사", lnCd: "4", lineName: "4호선" },
  ]);
});

test("KRIC provider code catalog는 header-only Sheet1을 거부한다", () => {
  assert.throws(() => buildProviderLineCatalog({
    sourceId: "kric-provider-code-catalog-20260228",
    sourceSha256: "a".repeat(64),
    capturedAt: "2026-07-19T00:00:00.000Z",
    sheets: [{ name: "Sheet1", rows: [[
      "RAIL_OPR_ISTT_CD", "RAIL_OPR_ISTT_NM", "LN_CD", "LN_NM", "STIN_CD", "STIN_NM",
    ]] }],
  }), /contains no station rows/);
});

test("KRIC catalog selects a unique header contract instead of a worksheet name", () => {
  const sheet = { name: "renamed station sheet", rows: [
    ["RAIL_OPR_ISTT_CD", "RAIL_OPR_ISTT_NM", "LN_CD", "LN_NM", "STIN_CD", "STIN_NM"],
    ["OP", "Operator", "L", "Line", "S", "Station"],
  ] };
  const input = { sourceId: "synthetic", sourceSha256: "a".repeat(64),
    capturedAt: "2020-01-01T00:00:00.000Z",
    sheets: [{ name: "Sheet1", rows: [["unrelated glossary"]] }, sheet] };
  assert.deepEqual(buildProviderLineCatalog(input).providerLines, [
    { railOprIsttCd: "OP", operatorName: "Operator", lnCd: "L", lineName: "Line" },
  ]);
  assert.throws(() => buildProviderLineCatalog({ ...input, sheets: [] }), /header is invalid/);
  assert.throws(() => buildProviderLineCatalog({ ...input, sheets: [sheet, sheet] }), /header is invalid/);
});

test("KRIC provider-line key가 다른 운영기관·노선명으로 충돌하면 거부한다", () => {
  assert.throws(() => buildProviderLineCatalog({
    sourceId: "kric-provider-code-catalog-20260228",
    sourceSha256: "a".repeat(64),
    capturedAt: "2026-07-19T00:00:00.000Z",
    sheets: [{ name: "Sheet1", rows: [
      ["RAIL_OPR_ISTT_CD", "RAIL_OPR_ISTT_NM", "LN_CD", "LN_NM", "STIN_CD", "STIN_NM"],
      ["S1", "서울교통공사", "4", "4호선", "433", "사당"],
      ["S1", "다른운영기관", "4", "다른노선", "434", "총신대입구"],
    ] }],
  }), /KRIC provider line conflict/);
});

test("KRIC XLSX parser는 외부 relation과 과도한 cell을 거부한다", () => {
  assert.throws(() => parseWorkbookSheetRefs(
    `<workbook xmlns:r="rels"><sheets><sheet name="x" r:id="r1"/></sheets></workbook>`,
    `<Relationships><Relationship Id="r1" Target="https://example.com/x.xml"/></Relationships>`,
  ), /worksheet target/);
  assert.throws(() => parseWorksheetRows(
    `<worksheet><sheetData><row><c r="CW1"><v>1</v></c></row></sheetData></worksheet>`,
    [],
  ), /column limit/);
});

test("KRIC XLSX shared string index는 비어 있거나 10진수가 아니면 거부한다", () => {
  for (const body of ["", "<v></v>", "<v> </v>", "<v>0x1</v>", "<v>1.0</v>"]) {
    assert.throws(() => parseWorksheetRows(
      `<worksheet><sheetData><row><c r="A1" t="s">${body}</c></row></sheetData></worksheet>`,
      ["zero", "one"],
    ), /shared string index is invalid/);
  }
});

test("extractXlsxWorkbookEntries는 외부 unzip 프로세스 없이 인메모리 bounded XLSX를 추출하고 경로 탈출을 거부한다", () => {
  const buildZip = (items) => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, content] of Object.entries(items)) {
      const nameBytes = Buffer.from(name, "utf8");
      const data = Buffer.from(content, "utf8");
      const checksum = crc32(data) >>> 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt32LE(checksum, 16);
      cd.writeUInt32LE(data.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBytes.length, 28);
      cd.writeUInt32LE(offset, 42);
      const entry = Buffer.concat([local, nameBytes, data]);
      locals.push(entry);
      centrals.push(Buffer.concat([cd, nameBytes]));
      offset += entry.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(locals.length, 8);
    eocd.writeUInt16LE(locals.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, eocd]);
  };

  const valid = buildZip({
    "xl/workbook.xml": `<workbook xmlns:r="rels"><sheets><sheet name="S" r:id="r1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>`,
  });
  const entries = extractXlsxWorkbookEntries(valid);
  assert.match(entries.get("xl/workbook.xml").toString("utf8"), /<workbook/);

  const zipSlip = buildZip({
    "../escape.xml": "<bad/>",
    "xl/workbook.xml": "<workbook/>",
    "xl/_rels/workbook.xml.rels": "<Relationships/>",
  });
  assert.throws(() => extractXlsxWorkbookEntries(zipSlip), /unsafe zip entry path/);
});
