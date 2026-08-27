import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { projectKricStationLineMembership } from "./project-kric-station-line-membership.mjs";

const HEADER = ["철도운영기관명", "운영노선", "역 종류", "역 번호", "역명(한글)", "역명(영어)", "역명(로마자)", "역명(일본어)", "역명(중국어간체)", "역명(중국어번체)", "역명(부역명)", "환승역 여부", "환승노선명", "유실물 취급여부", "안전발판 유무", "스크린도어 설치유무", "승강장 연결여부", "승강장 유형", "역 위치(경도)", "역 위치(위도)", "역 주소(지번주소)", "역 주소(도로명 주소)", "역사 전화번호", "신설일자", "폐지일자", "상행거리", "하행거리", "데이터 기준일자", "참고사항"];
const DENOMINATOR = JSON.parse(await readFile(new URL("./sources/molit-urban-rail-full-route-current-20260826T035408251Z.json", import.meta.url), "utf8"));
const RETAINED_CURRENT_WORKBOOK = await readFile(new URL(
  "./fixtures/capital-wide-rail-route-map-positions-raw/shared/kric-nationwide-urban-rail-station-info-20260701.xlsx",
  import.meta.url,
));

function fixture({ sourceRows = sourceRowsFor(DENOMINATOR), denominator = structuredClone(DENOMINATOR), header = HEADER, extraCell = "" } = {}) {
  return { workbookBytes: workbook(sourceRows, { header, extraCell }), denominator };
}

function sourceRowsFor(denominator) {
  return denominator.normalizedProjection.map(({ operator_name, line_name, station_name }, index) => ({ operator: operator_name, line: line_name, stationCode: `code-${index + 1}`, stationName: station_name }));
}

test("#455 current id=1294 workbook projects through exact NFC+trim operator/line/station identity", () => {
  const result = projectKricStationLineMembership(fixture());
  assert.equal(result.sourceId, "kric-current-station-line-file");
  assert.equal(result.records.length, 1103);
  const { station_sequence, ...first } = DENOMINATOR.normalizedProjection[0];
  assert.deepEqual(result.records[0], { ...first, source_station_code: "code-1" });
});

test("#455 keeps legacy API rosters, forged denominators, unmatched, duplicate, and subset inputs rejected", () => {
  assert.throws(() => projectKricStationLineMembership({ tally: {}, rosterArtifact: {} }), /DENOMINATOR_IDENTITY/);
  const staleObservation = fixture(); staleObservation.denominator.snapshotId = "molit-urban-rail-full-route-current-20260825T000000000Z";
  assert.throws(() => projectKricStationLineMembership(staleObservation), /DENOMINATOR_IDENTITY/);
  const forged = fixture(); forged.denominator.contentSha256 = "0".repeat(64);
  assert.throws(() => projectKricStationLineMembership(forged), /DENOMINATOR_CONTENT_HASH/);
  const subset = sourceRowsFor(DENOMINATOR).slice(0, -1);
  assert.throws(() => projectKricStationLineMembership(fixture({ sourceRows: subset })), /COVERAGE_INCOMPLETE/);
  const unmatched = sourceRowsFor(DENOMINATOR); unmatched[0].stationName = "없는역";
  assert.throws(() => projectKricStationLineMembership(fixture({ sourceRows: unmatched })), /UNMATCHED/);
  const duplicate = sourceRowsFor(DENOMINATOR); duplicate[1] = { ...duplicate[0], stationCode: "duplicate" };
  assert.throws(() => projectKricStationLineMembership(fixture({ sourceRows: duplicate })), /SOURCE_DUPLICATE/);
});

test("#455 pins the ordered 29-column header and rejects worksheet amplification outside A:AC", () => {
  const reordered = [...HEADER]; [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(() => projectKricStationLineMembership(fixture({ header: reordered })), /HEADER/);
  assert.throws(() => projectKricStationLineMembership(fixture({ extraCell: '<c r="AD2" t="inlineStr"><is><t>overflow</t></is></c>' })), /WORKSHEET/);
});

test("#455 retained current id=1294 bytes fail closed until an official full crosswalk is admitted", () => {
  assert.throws(
    () => projectKricStationLineMembership({
      workbookBytes: RETAINED_CURRENT_WORKBOOK,
      denominator: structuredClone(DENOMINATOR),
    }),
    /KRIC_STATION_LINE_UNMATCHED/,
  );
});

function workbook(rows, { header, extraCell }) {
  const cells = (values, number) => values.map((value, index) => `<c r="${column(index)}${number}" t="inlineStr"><is><t>${value}</t></is></c>`).join("");
  const sheet = `<worksheet><sheetData><row r="1">${cells(header, 1)}</row>${rows.map((source, index) => { const values = Array(29).fill(""); [values[0], values[1], values[3], values[4]] = [source.operator, source.line, source.stationCode, source.stationName]; return `<row r="${index + 2}">${cells(values, index + 2)}${index === 0 ? extraCell : ""}</row>`; }).join("")}</sheetData></worksheet>`;
  return zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook xmlns:r=\"r\"><sheets><sheet name=\"1.역사정보\" r:id=\"rId1\"/></sheets></workbook>", "xl/_rels/workbook.xml.rels": "<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>", "xl/worksheets/sheet1.xml": sheet });
}

function zip(entries) {
  let offset = 0; const locals = [];
  for (const [name, text] of Object.entries(entries)) { const filename = Buffer.from(name); const content = Buffer.from(text); const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(filename.length, 26); header.writeUInt32LE(content.length, 18); locals.push({ filename, content, offset, entry: Buffer.concat([header, filename, content]) }); offset += 30 + filename.length + content.length; }
  const central = locals.map(({ filename, content, offset: localOffset }) => { const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(content.length, 20); header.writeUInt32LE(content.length, 24); header.writeUInt32LE(localOffset, 42); return Buffer.concat([header, filename]); });
  const centralBytes = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(locals.length, 8); eocd.writeUInt16LE(locals.length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16); return Buffer.concat([...locals.map(({ entry }) => entry), centralBytes, eocd]);
}

function column(index) { let value = index + 1; let result = ""; while (value > 0) { value -= 1; result = String.fromCodePoint(65 + (value % 26)) + result; value = Math.floor(value / 26); } return result; }
