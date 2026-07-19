import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderLineCatalog,
  parseSharedStrings,
  parseWorkbookSheetRefs,
  parseWorksheetRows,
} from "./parse-kric-code-catalog.mjs";

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
