import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildKricCurrentStationLineObservation } from "./build-kric-current-station-line-observation.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const fixture = path.join(root, "tools/datapack/fixtures/capital-wide-rail-route-map-positions-raw/shared/kric-nationwide-urban-rail-station-info-20260701.xlsx");
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function input() {
  const workbookBytes = await readFile(fixture);
  return {
    workbookBytes,
    receipt: {
      schemaVersion: 1,
      artifactKind: "kric-current-station-line-file-receipt",
      sourceId: "kric-current-station-line-file",
      capturedAt: "2026-08-27T00:00:00.000Z",
      rawFile: "kric-current-station-line-file-20260827.xlsx",
      byteLength: workbookBytes.length,
      sha256: sha(workbookBytes),
      credentialRedacted: true,
    },
  };
}

test("#455 produces a deterministic source-native observation from the retained KRIC workbook", async () => {
  const value = await input();
  const first = buildKricCurrentStationLineObservation(value);
  const second = buildKricCurrentStationLineObservation(structuredClone(value));
  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.artifactKind, "kric-current-station-line-observation");
  assert.equal(first.sourceId, "kric-current-station-line-file");
  assert.equal(first.observedAt, value.receipt.capturedAt);
  assert.equal(first.rawFile, value.receipt.rawFile);
  assert.equal(first.rawByteLength, value.workbookBytes.length);
  assert.equal(first.rawSha256, sha(value.workbookBytes));
  assert.equal(first.rowCount, 1_108);
  assert.equal(first.records.length, 1_108);
  assert.deepEqual(Object.keys(first.records[0]), ["operatorName", "lineName", "stationNumber", "stationName", "sourceRowSha256"]);
  assert.equal(first.recordsSha256, sha(Buffer.from(`${JSON.stringify(first.records)}\n`)));
  for (const record of first.records) {
    assert.deepEqual(Object.keys(record), ["operatorName", "lineName", "stationNumber", "stationName", "sourceRowSha256"]);
    assert.equal(record.sourceRowSha256, sha(JSON.stringify({
      operatorName: record.operatorName,
      lineName: record.lineName,
      stationNumber: record.stationNumber,
      stationName: record.stationName,
    })));
    for (const forbidden of ["stationId", "lineId", "route", "search", "topology", "admission", "status", "GO", "OCI"]) {
      assert.equal(Object.hasOwn(record, forbidden), false);
    }
  }
});

test("#455 rejects receipt mismatch and content drift before any observation is emitted", async () => {
  const cases = [
    ["schema", (value) => { value.receipt.schemaVersion = 2; }, /KRIC_CURRENT_STATION_LINE_OBSERVATION_RECEIPT/],
    ["kind", (value) => { value.receipt.artifactKind = "wrong"; }, /KRIC_CURRENT_STATION_LINE_OBSERVATION_RECEIPT/],
    ["source", (value) => { value.receipt.sourceId = "wrong"; }, /KRIC_CURRENT_STATION_LINE_OBSERVATION_RECEIPT/],
    ["clock", (value) => { value.receipt.capturedAt = "2026-08-27T00:00:00Z"; }, /KRIC_CURRENT_STATION_LINE_OBSERVATION_RECEIPT/],
    ["filename", (value) => { value.receipt.rawFile = "foreign.xlsx"; }, /KRIC_CURRENT_STATION_LINE_OBSERVATION_RECEIPT/],
    ["bytes", (value) => { value.receipt.byteLength -= 1; }, /KRIC_CURRENT_STATION_LINE_OBSERVATION_CONTENT_DRIFT/],
    ["hash", (value) => { value.receipt.sha256 = "0".repeat(64); }, /KRIC_CURRENT_STATION_LINE_OBSERVATION_CONTENT_DRIFT/],
    ["redaction", (value) => { value.receipt.credentialRedacted = false; }, /KRIC_CURRENT_STATION_LINE_OBSERVATION_RECEIPT/],
  ];
  for (const [name, mutate, expected] of cases) {
    const value = await input();
    mutate(value);
    assert.throws(() => buildKricCurrentStationLineObservation(value), expected, name);
  }
});

test("#455 rejects malformed input and preserves duplicate exact source tuples", () => {
  const receipt = (workbookBytes) => ({
    schemaVersion: 1, artifactKind: "kric-current-station-line-file-receipt", sourceId: "kric-current-station-line-file",
    capturedAt: "2026-08-27T00:00:00.000Z", rawFile: "kric-current-station-line-file-test.xlsx",
    byteLength: workbookBytes.length, sha256: sha(workbookBytes), credentialRedacted: true,
  });
  const malformed = Buffer.from("not an xlsx");
  assert.throws(() => buildKricCurrentStationLineObservation({ workbookBytes: malformed, receipt: receipt(malformed) }), /KRIC_CURRENT_STATION_LINE_OBSERVATION_WORKBOOK/);
  const duplicate = minimalWorkbook([
    ["운영기관", "1호선", "100", "역A"],
    ["운영기관", "1호선", "100", "역A"],
  ]);
  const result = buildKricCurrentStationLineObservation({ workbookBytes: duplicate, receipt: receipt(duplicate) });
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.records[0], result.records[1]);
});

function minimalWorkbook(rows) {
  const header = ["철도운영기관명", "운영노선", "역 종류", "역 번호", "역명(한글)", "역명(영어)", "역명(로마자)", "역명(일본어)", "역명(중국어간체)", "역명(중국어번체)", "역명(부역명)", "환승역 여부", "환승노선명", "유실물 취급여부", "안전발판 유무", "스크린도어 설치유무", "승강장 연결여부", "승강장 유형", "역 위치(경도)", "역 위치(위도)", "역 주소(지번주소)", "역 주소(도로명 주소)", "역사 전화번호", "신설일자", "폐지일자", "상행거리", "하행거리", "데이터 기준일자", "참고사항"];
  const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const row = (values, number) => `<row r="${number}">${values.map((value, index) => `<c r="${column(index)}${number}" t="inlineStr"><is><t>${esc(value ?? "")}</t></is></c>`).join("")}</row>`;
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${row(header, 1)}${rows.map((value, index) => row([value[0], value[1], "도시철도", value[2], value[3]], index + 2)).join("")}</sheetData></worksheet>`;
  return zip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": "<workbook><sheets><sheet name=\"1.역사정보\" r:id=\"rId1\"/></sheets></workbook>",
    "xl/_rels/workbook.xml.rels": "<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>",
    "xl/worksheets/sheet1.xml": sheet,
  });
}

function column(index) { let value = ""; for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) value = String.fromCharCode(65 + ((current - 1) % 26)) + value; return value; }

function zip(entries) {
  let offset = 0;
  const locals = Object.entries(entries).map(([name, value]) => {
    const filename = Buffer.from(name); const data = Buffer.from(value); const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.concat([header, filename, data]); const result = { filename, data, offset, entry }; offset += entry.length; return result;
  });
  const central = locals.map(({ filename, data, offset: localOffset }) => { const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(localOffset, 42); return Buffer.concat([header, filename]); });
  const centralBytes = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(locals.length, 8); end.writeUInt16LE(locals.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals.map(({ entry }) => entry), centralBytes, end]);
}
