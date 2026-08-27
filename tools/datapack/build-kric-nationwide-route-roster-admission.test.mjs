import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { buildKricNationwideRouteRosterAdmissionContract } from "./build-kric-nationwide-route-roster-admission.mjs";
import { projectKricStationLineMembership } from "./project-kric-station-line-membership.mjs";

const HEADER = ["철도운영기관명", "운영노선", "역 종류", "역 번호", "역명(한글)", "역명(영어)", "역명(로마자)", "역명(일본어)", "역명(중국어간체)", "역명(중국어번체)", "역명(부역명)", "환승역 여부", "환승노선명", "유실물 취급여부", "안전발판 유무", "스크린도어 설치유무", "승강장 연결여부", "승강장 유형", "역 위치(경도)", "역 위치(위도)", "역 주소(지번주소)", "역 주소(도로명 주소)", "역사 전화번호", "신설일자", "폐지일자", "상행거리", "하행거리", "데이터 기준일자", "참고사항"];
const DENOMINATOR = JSON.parse(await readFile(new URL("./sources/molit-urban-rail-full-route-current-20260826T035408251Z.json", import.meta.url), "utf8"));

function fixture() {
  const workbookBytes = workbook();
  const denominator = structuredClone(DENOMINATOR);
  const projection = projectKricStationLineMembership({ workbookBytes, denominator });
  return { workbookBytes, denominator, projection, receipt: { schemaVersion: 1, artifactKind: "kric-current-station-line-file-receipt", sourceId: "kric-current-station-line-file", capturedAt: "2026-08-27T00:00:00.000Z", rawFile: "kric-current-station-line-file-test.xlsx", byteLength: workbookBytes.length, sha256: createHash("sha256").update(workbookBytes).digest("hex"), credentialRedacted: true } };
}

test("#455 exact workbook/receipt/projection binding returns deterministic PENDING without an OCI or release success", () => {
  const input = fixture();
  const result = buildKricNationwideRouteRosterAdmissionContract(input);
  assert.equal(result.status, "PENDING");
  assert.equal(result.decision, "CONTRACT_GAP");
  assert.equal(result.sourceId, "kric-current-station-line-file");
  assert.deepEqual(result.gaps, [{ code: "CROSSWALK_NOT_ADMITTED", status: "PENDING", decision: "CONTRACT_GAP" }]);
  assert.notEqual(result.status, "GO");
  assert.ok(!Object.hasOwn(result, "oci"));
});

test("#455 rejects altered bytes, malformed receipts, and projections", () => {
  const input = fixture();
  assert.throws(() => buildKricNationwideRouteRosterAdmissionContract({ ...input, receipt: { ...input.receipt, sha256: "0".repeat(64) } }), /RECEIPT_MISMATCH/);
  for (const receipt of [
    { ...input.receipt, schemaVersion: 2 },
    { ...input.receipt, capturedAt: "2026-08-27T00:00:00Z" },
    { ...input.receipt, rawFile: "foreign.xlsx" },
    { ...input.receipt, credentialRedacted: false },
  ]) assert.throws(() => buildKricNationwideRouteRosterAdmissionContract({ ...input, receipt }), /RECEIPT_MISMATCH/);
  assert.throws(() => buildKricNationwideRouteRosterAdmissionContract({ ...input, projection: { ...input.projection, records: [] } }), /PROJECTION_MISMATCH/);
});

test("#455 keeps legacy API/18-scope/id32/OCI shapes as explicit rejection regressions", () => {
  assert.throws(() => buildKricNationwideRouteRosterAdmissionContract({ tally: { targetVersion: "2026-07-13" }, rosterArtifact: {}, sourceInventory: {}, sourceSnapshots: [], rawReceipt: {}, licenseDecision: {} }), /DENOMINATOR_IDENTITY/);
  const input = fixture(); input.denominator.rowCount = 22;
  assert.throws(() => buildKricNationwideRouteRosterAdmissionContract(input), /DENOMINATOR_IDENTITY/);
});

function workbook() {
  const cells = (values, row) => values.map((value, index) => `<c r="${column(index)}${row}" t="inlineStr"><is><t>${value}</t></is></c>`).join("");
  const rows = DENOMINATOR.normalizedProjection.map(({ operator_name, line_name, station_name }, index) => { const values = Array(29).fill(""); [values[0], values[1], values[3], values[4]] = [operator_name, line_name, `code-${index + 1}`, station_name]; return `<row r="${index + 2}">${cells(values, index + 2)}</row>`; }).join("");
  return zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook xmlns:r=\"r\"><sheets><sheet name=\"1.역사정보\" r:id=\"rId1\"/></sheets></workbook>", "xl/_rels/workbook.xml.rels": "<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>", "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1">${cells(HEADER, 1)}</row>${rows}</sheetData></worksheet>` });
}

function zip(entries) { let offset = 0; const locals = Object.entries(entries).map(([name, text]) => { const filename = Buffer.from(name); const content = Buffer.from(text); const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(filename.length, 26); header.writeUInt32LE(content.length, 18); const entry = Buffer.concat([header, filename, content]); const value = { filename, content, offset, entry }; offset += entry.length; return value; }); const central = Buffer.concat(locals.map(({ filename, content, offset: localOffset }) => { const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(content.length, 20); header.writeUInt32LE(content.length, 24); header.writeUInt32LE(localOffset, 42); return Buffer.concat([header, filename]); })); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(locals.length, 8); eocd.writeUInt16LE(locals.length, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16); return Buffer.concat([...locals.map(({ entry }) => entry), central, eocd]); }

function column(index) { let value = index + 1; let result = ""; while (value > 0) { value -= 1; result = String.fromCodePoint(65 + (value % 26)) + result; value = Math.floor(value / 26); } return result; }
