import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createKricRetainedFilePublisher, parseKricRetainedFileOperationArgs, runKricRetainedFileOperation, sanitizedOperationError } from "./run-kric-retained-file-operation.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const MAIN = "a".repeat(40);

test("parses the closed tracked operation CLI", () => {
  const argv = ["--operation-root", "/private/op", "--timetable-input", "/private/timetable.xlsx", "--timetable-receipt", "/private/timetable.json", "--station-line-input", "/private/stations.xlsx", "--station-line-receipt", "/private/stations.json", "--expected-main-sha", MAIN, "--operation-id", "kric-retained-454-455"];
  assert.equal(parseKricRetainedFileOperationArgs(argv)["expected-main-sha"], MAIN);
  assert.throws(() => parseKricRetainedFileOperationArgs([...argv, "--operation-id", "duplicate"]), /ARGUMENTS/);
  assert.throws(() => parseKricRetainedFileOperationArgs(["xxoperation-root", ...argv.slice(1)]), /ARGUMENTS/);
  assert.equal(sanitizedOperationError(new Error("/private/secret/path")), "KRIC_RETAINED_FILE_OPERATION_FAILED");
});

test("uses the current source-publication OCI contract and rejects candidate-only credentials", async () => {
  const env = {
    EASYSUBWAY_OBJECT_STORAGE_ENDPOINT: "https://object.example",
    EASYSUBWAY_DATAPACK_BUCKET: "easysubway-datapacks",
    EASYSUBWAY_OBJECT_STORAGE_REGION: "ap-seoul-1",
    EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY: "access",
    EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY: "secret",
  };
  const body = Buffer.from("retained");
  let receivedEnv;
  let receivedStep;
  const publisher = createKricRetainedFilePublisher(env, (value) => {
    receivedEnv = value;
    return {
      async putObjectIfAbsent(_key, _bytes, step) { receivedStep = step; return true; },
      async readObject() { return { exists: true, body }; },
    };
  });
  assert.equal(await publisher.putObjectIfAbsent("source-raw/example", body), true);
  assert.deepEqual(receivedStep, { sha256: sha(body), sizeBytes: body.length });
  assert.deepEqual(await publisher.fullGet("source-raw/example"), body);
  assert.strictEqual(receivedEnv, env);
  assert.throws(() => createKricRetainedFilePublisher({
    EASYSUBWAY_CANDIDATE_OCI_NAMESPACE: "namespace",
    EASYSUBWAY_CANDIDATE_OCI_BUCKET: "bucket",
    EASYSUBWAY_CANDIDATE_OCI_REGION: "region",
    EASYSUBWAY_CANDIDATE_OCI_ACCESS_KEY: "access",
    EASYSUBWAY_CANDIDATE_OCI_SECRET_KEY: "secret",
  }), /KRIC_RETAINED_FILE_OPERATION_OCI_ENV/);
});

test("publishes the fixed retained-file sequence and writes a pending receipt last", async () => {
  const value = await fixture();
  try {
    const calls = []; const objects = new Map();
    const publisher = { async putObjectIfAbsent(key, bytes) { calls.push(`PUT ${key}`); objects.set(key, Buffer.from(bytes)); return true; }, async fullGet(key) { calls.push(`GET ${key}`); return objects.get(key); } };
    const result = await run(value, publisher);
    assert.deepEqual(calls.map((item) => item.slice(0, 3)), ["PUT", "GET", "PUT", "GET", "PUT", "GET", "PUT", "GET", "PUT", "GET"]);
    assert.match(calls[0], /^PUT source-raw\/kric-nationwide-timetable-file\/20260827\/[a-f0-9]{64}\.xlsx$/);
    assert.match(calls[2], /^PUT source-raw\/kric-current-station-line-file\/20260828\/[a-f0-9]{64}\.xlsx$/);
    assert.match(calls[4], /^PUT source-observation\/kric-nationwide-timetable-file\/20260827\/[a-f0-9]{64}\.json$/);
    assert.match(calls[6], /^PUT source-observation\/kric-current-station-line-file\/20260828\/[a-f0-9]{64}\.json$/);
    assert.match(calls[8], /^PUT kric-retained-file-operations\/[a-f0-9]{64}\.json$/);
    const journal = JSON.parse(await readFile(path.join(value.operationRoot, "journal.json"), "utf8"));
    const receiptBytes = await readFile(path.join(value.operationRoot, "publication-receipt.json"));
    assert.equal(journal.phase, "TERMINAL_PENDING"); assert.equal(JSON.parse(receiptBytes).releaseEligible, false);
    assert.equal((await stat(path.join(value.operationRoot, "journal.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(value.operationRoot, "publication-receipt.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(value.operationRoot)).mode & 0o777, 0o700);
    assert.equal(result.receipt.objects.length, 5);
    assert.equal(result.receipt.objects.at(-1).sha256, result.receipt.bundleSha256);
    for (const payload of [JSON.stringify(result.bundle), receiptBytes.toString("utf8")]) for (const forbidden of ["GO", "activation", "provider", "AWS"]) assert.equal(payload.includes(forbidden), false);
  } finally { await cleanup(value); }
});

test("rejects malformed retained inputs before any publisher call", async () => {
  const value = await fixture();
  try {
    await writeFile(value.timetableReceiptPath, "{}", { mode: 0o600 });
    let calls = 0;
    await assert.rejects(run(value, { async putObjectIfAbsent() { calls += 1; }, async fullGet() { calls += 1; } }), /RECEIPT/);
    assert.equal(calls, 0);
  } finally { await cleanup(value); }
});

test("rejects oversized retained input before allocation or publisher use", async () => {
  const value = await fixture();
  try {
    await truncate(value.timetableInputPath, 128 * 1024 * 1024 + 1);
    let calls = 0;
    await assert.rejects(run(value, {
      async putObjectIfAbsent() { calls += 1; }, async fullGet() { calls += 1; },
    }), /TIMETABLE_INPUT/);
    assert.equal(calls, 0);
  } finally { await cleanup(value); }
});

test("records terminal failure without a receipt for collision and GET drift", async () => {
  for (const publisher of [
    { async putObjectIfAbsent() { return false; }, async fullGet() { throw new Error("unexpected"); } },
    { async putObjectIfAbsent() { return true; }, async fullGet() { return Buffer.from("drift"); } },
  ]) {
    const value = await fixture();
    try {
      await assert.rejects(run(value, publisher), /KRIC_RETAINED_FILE_OPERATION_(COLLISION|FULL_GET)/);
      assert.equal(JSON.parse(await readFile(path.join(value.operationRoot, "journal.json"), "utf8")).phase, "TERMINAL_FAILED");
      await assert.rejects(readFile(path.join(value.operationRoot, "publication-receipt.json")));
    } finally { await cleanup(value); }
  }
});

test("records objects created before a later full-GET failure", async () => {
  const value = await fixture();
  try {
    let index = 0; const objects = new Map();
    const publisher = {
      async putObjectIfAbsent(key, bytes) { objects.set(key, Buffer.from(bytes)); return true; },
      async fullGet(key) { index += 1; return index === 3 ? Buffer.from("drift") : objects.get(key); },
    };
    await assert.rejects(run(value, publisher), /FULL_GET/);
    const journal = JSON.parse(await readFile(path.join(value.operationRoot, "journal.json"), "utf8"));
    assert.equal(journal.phase, "TERMINAL_FAILED");
    assert.equal(journal.createdObjects.length, 3);
    assert.equal(journal.verifiedObjects.length, 2);
    await assert.rejects(readFile(path.join(value.operationRoot, "publication-receipt.json")));
  } finally { await cleanup(value); }
});

test("refuses a second invocation before publisher use", async () => {
  const value = await fixture();
  try {
    const good = memoryPublisher(); await run(value, good);
    let calls = 0;
    await assert.rejects(run(value, { async putObjectIfAbsent() { calls += 1; return true; }, async fullGet() { calls += 1; return Buffer.alloc(1); } }), /OPERATION_EXISTS/);
    assert.equal(calls, 0);
  } finally { await cleanup(value); }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-retained-operation-")); const repositoryRoot = path.join(root, "repo"); const inputs = path.join(root, "inputs"); const operationRoot = path.join(root, "operation");
  await writeFile(path.join(root, "placeholder"), "x"); await rm(path.join(root, "placeholder"));
  await (await import("node:fs/promises")).mkdir(repositoryRoot); await (await import("node:fs/promises")).mkdir(inputs);
  const timetableBytes = timetableWorkbook(); const stationBytes = stationWorkbook();
  const timetableInputPath = path.join(inputs, "kric-nationwide-timetable-file-test.xlsx"); const stationLineInputPath = path.join(inputs, "kric-current-station-line-file-test.xlsx");
  const timetableReceiptPath = path.join(inputs, "timetable-receipt.json"); const stationLineReceiptPath = path.join(inputs, "station-receipt.json");
  await writeFile(timetableInputPath, timetableBytes, { mode: 0o600 }); await writeFile(stationLineInputPath, stationBytes, { mode: 0o600 });
  await writeFile(timetableReceiptPath, `${JSON.stringify(receipt("kric-nationwide-timetable-file", "kric-nationwide-timetable-file-test.xlsx", timetableBytes, "2026-08-27T00:00:00.000Z"), null, 2)}\n`, { mode: 0o600 });
  await writeFile(stationLineReceiptPath, `${JSON.stringify(receipt("kric-current-station-line-file", "kric-current-station-line-file-test.xlsx", stationBytes, "2026-08-28T00:00:00.000Z"), null, 2)}\n`, { mode: 0o600 });
  for (const item of [timetableInputPath, stationLineInputPath, timetableReceiptPath, stationLineReceiptPath]) await chmod(item, 0o600);
  return { root, repositoryRoot, operationRoot, timetableInputPath, stationLineInputPath, timetableReceiptPath, stationLineReceiptPath };
}
function receipt(sourceId, rawFile, bytes, capturedAt) { return { schemaVersion: 1, artifactKind: `${sourceId}-receipt`, sourceId, capturedAt, rawFile, byteLength: bytes.length, sha256: sha(bytes), credentialRedacted: true }; }
function run(value, publisher) { return runKricRetainedFileOperation({ ...value, expectedMainSha: MAIN, operationId: "kric-retained-454-455", assertExactMain: async ({ expectedMainSha }) => expectedMainSha, publisher }); }
function memoryPublisher() { const objects = new Map(); return { async putObjectIfAbsent(key, bytes) { objects.set(key, Buffer.from(bytes)); return true; }, async fullGet(key) { return objects.get(key); } }; }
async function cleanup(value) { await rm(value.root, { recursive: true, force: true }); }

function timetableWorkbook() { return zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook xmlns:r=\"r\"><sheets><sheet name=\"표준데이터 운행(전체)\" r:id=\"rId1\"/></sheets></workbook>", "xl/_rels/workbook.xml.rels": "<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>", "xl/styles.xml": "<styleSheet><cellXfs><xf/></cellXfs></styleSheet>", "xl/worksheets/sheet1.xml": sheet([['열차번호','노선번호','노선명','운행구간기점명','운행구간종점명','운행유형','요일구분','운행구간정거장','정거장도착시각','정가장출발시각','운행속도','운영기관전화번호','데이터기준일자'], ['T1','R','노선','A','B','일반','평일','역A','08:00','','','','']]) }); }
function stationWorkbook() { const header = ['철도운영기관명','운영노선','역 종류','역 번호','역명(한글)','역명(영어)','역명(로마자)','역명(일본어)','역명(중국어간체)','역명(중국어번체)','역명(부역명)','환승역 여부','환승노선명','유실물 취급여부','안전발판 유무','스크린도어 설치유무','승강장 연결여부','승강장 유형','역 위치(경도)','역 위치(위도)','역 주소(지번주소)','역 주소(도로명 주소)','역사 전화번호','신설일자','폐지일자','상행거리','하행거리','데이터 기준일자','참고사항']; const row = Array(29).fill(''); Object.assign(row, { 0: '운영기관', 1: '1호선', 2: '도시철도', 3: '100', 4: '역A' }); return zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook><sheets><sheet name=\"1.역사정보\" r:id=\"rId1\"/></sheets></workbook>", "xl/_rels/workbook.xml.rels": "<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>", "xl/worksheets/sheet1.xml": sheet([header, row]) }); }
function sheet(rows) { return `<worksheet><sheetData>${rows.map((row, r) => `<row r=\"${r + 1}\">${row.map((cell, c) => `<c r=\"${column(c)}${r + 1}\" t=\"inlineStr\"><is><t>${cell}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`; }
function column(index) { let value = ""; for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) value = String.fromCharCode(65 + ((current - 1) % 26)) + value; return value; }
function zip(entries) { let offset = 0; const records = Object.entries(entries).map(([name, text]) => { const filename = Buffer.from(name); const data = Buffer.from(text); const crc = crc32(data); const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26); const entry = Buffer.concat([header, filename, data]); const out = { filename, data, crc, offset, entry }; offset += entry.length; return out; }); const central = records.map(({ filename, data, crc, offset: local }) => { const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(local, 42); return Buffer.concat([header, filename]); }); const body = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10); end.writeUInt32LE(body.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...records.map(({ entry }) => entry), body, end]); }
function crc32(buffer) { let value = 0xffffffff; for (const byte of buffer) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) * 0xedb88320); } return (value ^ 0xffffffff) >>> 0; }
