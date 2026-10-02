import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertAppendOnlyReverifications,
  parseRegisterKricCapitalTimetableArgs,
  planKricCapitalTimetableRegistration,
  registerKricCapitalTimetable,
} from "./register-kric-capital-timetable.mjs";
import { KRIC_CAPITAL_ROUTE_PROFILES } from "./lib/kric-capital-timetable-records.mjs";
import { RAW_PUBLICATION_MODE } from "./lib/same-raw-reverification.mjs";

// #870: 같은 원본(raw sha256)을 다시 수집하면 snapshot 파일을 새로 만들지 않고 재확인 이력만 append한다.
const RAW = "a".repeat(64);
const RECORDS = "b".repeat(64);
const snapshot = (rawSha256 = RAW, recordsSha256 = RECORDS) => ({ snapshotId: `kric-nationwide-timetable-file-capital-${recordsSha256}`, rawSha256, recordsSha256 });
const bytesOf = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const observation = (observedAt, collectionReceiptSha256 = "c".repeat(64)) => ({ observedAt, collectionReceiptSha256 });
const template = (value) => ({ issue: 899, snapshotId: value.snapshotId, snapshotPath: `tools/datapack/sources/${value.snapshotId}.json`, rawSha256: value.rawSha256, recordsSha256: value.recordsSha256 });
const NOW = new Date("2026-10-09T15:10:00.000Z");
const FIRST_NOW = new Date("2026-10-02T16:00:00.000Z");
const first = () => planKricCapitalTimetableRegistration({
  previousEvidence: null, snapshot: snapshot(), snapshotBytes: bytesOf(snapshot()), existingSnapshotBytes: null,
  observation: observation("2026-10-02T15:57:05.773Z"), evidenceTemplate: template(snapshot()), now: FIRST_NOW,
});

test("첫 등록은 snapshot 파일을 쓰고 재확인 이력 첫 항목을 만든다", () => {
  const plan = first();
  assert.equal(plan.mode, RAW_PUBLICATION_MODE.PUBLISH_NEW);
  assert.equal(plan.writeSnapshot, true);
  assert.equal(plan.evidence.observedAt, "2026-10-02T15:57:05.773Z");
  assert.deepEqual(plan.evidence.reverifications, [{ observedAt: "2026-10-02T15:57:05.773Z", rawSha256: RAW, collectionReceiptSha256: "c".repeat(64) }]);
});

test("같은 원본 재수집은 snapshot 파일을 쓰지 않고 재확인 이력만 append하며 관측 시각을 갱신한다", () => {
  const previous = first().evidence;
  const plan = planKricCapitalTimetableRegistration({
    previousEvidence: previous, snapshot: snapshot(), snapshotBytes: bytesOf(snapshot()), existingSnapshotBytes: bytesOf(snapshot()),
    observation: observation("2026-10-09T15:00:00.000Z", "d".repeat(64)), evidenceTemplate: template(snapshot()), now: NOW,
  });
  assert.equal(plan.mode, RAW_PUBLICATION_MODE.REVERIFY_EXISTING);
  assert.equal(plan.writeSnapshot, false);
  assert.equal(plan.evidence.observedAt, "2026-10-09T15:00:00.000Z");
  assert.deepEqual(plan.evidence.reverifications.slice(0, -1), previous.reverifications);
  assert.deepEqual(plan.evidence.reverifications.at(-1), { observedAt: "2026-10-09T15:00:00.000Z", rawSha256: RAW, collectionReceiptSha256: "d".repeat(64) });
});

test("다른 원본은 새 snapshot 파일을 쓰고 이력은 이어 붙인다", () => {
  const previous = first().evidence;
  const next = snapshot("e".repeat(64), "f".repeat(64));
  const plan = planKricCapitalTimetableRegistration({
    previousEvidence: previous, snapshot: next, snapshotBytes: bytesOf(next), existingSnapshotBytes: null,
    observation: observation("2026-10-09T15:00:00.000Z"), evidenceTemplate: template(next), now: NOW,
  });
  assert.equal(plan.mode, RAW_PUBLICATION_MODE.PUBLISH_NEW);
  assert.equal(plan.writeSnapshot, true);
  assert.equal(plan.evidence.snapshotId, next.snapshotId);
  assert.deepEqual(plan.evidence.reverifications.slice(0, -1), previous.reverifications);
});

test("같은 원본인데 records·기존 snapshot 바이트가 다르거나, 관측 시각이 앞서지 않거나, 이력이 바뀌었으면 실패한다", () => {
  const previous = first().evidence;
  const base = { previousEvidence: previous, snapshot: snapshot(), snapshotBytes: bytesOf(snapshot()), existingSnapshotBytes: bytesOf(snapshot()),
    observation: observation("2026-10-09T15:00:00.000Z"), evidenceTemplate: template(snapshot()), now: NOW };
  const changedRecords = snapshot(RAW, "9".repeat(64));
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, snapshot: changedRecords, snapshotBytes: bytesOf(changedRecords), evidenceTemplate: template(changedRecords) }), /RECORDS_MISMATCH/u);
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, existingSnapshotBytes: null }), /SNAPSHOT_MISMATCH/u);
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, existingSnapshotBytes: Buffer.from("{}\n") }), /SNAPSHOT_MISMATCH/u);
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, observation: observation("2026-10-02T15:57:05.773Z"), now: FIRST_NOW }), /OBSERVATION_ORDER/u);
  // 이전 evidence의 이력 끝이 evidence 관측 시각·원본과 맞지 않으면(손으로 고친 이력) 실패한다.
  const tampered = { ...previous, reverifications: [{ ...previous.reverifications[0], observedAt: "2026-10-01T00:00:00.000Z" }] };
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, previousEvidence: tampered }), /REVERIFICATIONS/u);
});

test("재확인 이력은 append-only다: 기존 항목을 바꾸거나 지우면 실패한다", () => {
  const previous = first().evidence.reverifications;
  const appended = [...previous, { observedAt: "2026-10-09T15:00:00.000Z", rawSha256: RAW, collectionReceiptSha256: "d".repeat(64) }];
  assert.doesNotThrow(() => assertAppendOnlyReverifications(previous, appended));
  assert.throws(() => assertAppendOnlyReverifications(previous, [{ ...appended[0], collectionReceiptSha256: "0".repeat(64) }, appended[1]]), /REVERIFICATIONS_APPEND_ONLY/u);
  assert.throws(() => assertAppendOnlyReverifications(previous, appended.slice(1)), /REVERIFICATIONS_APPEND_ONLY/u);
  assert.throws(() => assertAppendOnlyReverifications(previous, previous), /REVERIFICATIONS_APPEND_ONLY/u);
});

// #911 F3: 원본이 A → B → A로 돌아오면 A snapshot 파일이 이미 있다. 바이트가 같으면 다시 쓰지 않고 재사용하고, 다르면 실패한다.
test("원본이 이전 snapshot으로 돌아오면 같은 바이트의 기존 파일을 재사용하고, 다르면 실패한다(#911 F3)", () => {
  const a = snapshot();
  const b = snapshot("e".repeat(64), "f".repeat(64));
  const afterA = first().evidence;
  const afterB = planKricCapitalTimetableRegistration({ previousEvidence: afterA, snapshot: b, snapshotBytes: bytesOf(b), existingSnapshotBytes: null,
    observation: observation("2026-10-05T15:00:00.000Z"), evidenceTemplate: template(b), now: new Date("2026-10-05T15:05:00.000Z") }).evidence;
  const backToA = { previousEvidence: afterB, snapshot: a, snapshotBytes: bytesOf(a), observation: observation("2026-10-09T15:00:00.000Z"), evidenceTemplate: template(a), now: NOW };
  const plan = planKricCapitalTimetableRegistration({ ...backToA, existingSnapshotBytes: bytesOf(a) });
  assert.equal(plan.mode, RAW_PUBLICATION_MODE.PUBLISH_NEW);
  assert.equal(plan.writeSnapshot, false);
  assert.equal(plan.evidence.snapshotId, a.snapshotId);
  assert.deepEqual(plan.evidence.reverifications.map(({ rawSha256 }) => rawSha256), [RAW, "e".repeat(64), RAW]);
  assert.throws(() => planKricCapitalTimetableRegistration({ ...backToA, existingSnapshotBytes: Buffer.from("{}\n") }), /SNAPSHOT_MISMATCH/u);
});

// #911 F1: 관측 시각은 등록 실행의 시계 기준으로 검사한다. 미래이거나 수집 실행 허용 시간(1시간)보다 오래되면 실패한다.
test("관측 시각이 등록 시계보다 미래이거나 1시간보다 오래되면 재확인 이력을 붙이지 않는다(#911 F1)", () => {
  const previous = first().evidence;
  const base = { previousEvidence: previous, snapshot: snapshot(), snapshotBytes: bytesOf(snapshot()), existingSnapshotBytes: bytesOf(snapshot()),
    evidenceTemplate: template(snapshot()), now: NOW };
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, observation: observation("2026-10-09T15:10:00.001Z") }), /OBSERVATION_CLOCK/u);
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, observation: observation("2026-10-09T14:09:59.999Z") }), /OBSERVATION_CLOCK/u);
  assert.equal(planKricCapitalTimetableRegistration({ ...base, observation: observation("2026-10-09T14:10:00.000Z") }).mode, RAW_PUBLICATION_MODE.REVERIFY_EXISTING);
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, observation: observation("2026-10-09T15:00:00.000Z"), now: undefined }), /CLOCK/u);
});

// #911 F1: 등록기는 원본을 직접 받아(실제 GET·sha 계산) 같은 실행에서 만든 영수증만 쓴다. 외부 영수증 파일은 받지 않는다.
test("등록기는 같은 실행에서 원본을 직접 수집한 관측만 등록하고 외부 영수증 인자를 받지 않는다(#911 F1)", async () => {
  assert.throws(() => parseRegisterKricCapitalTimetableArgs(["--workbook", "/tmp/a.xlsx", "--receipt", "/tmp/r.json"]), /usage/u);
  assert.deepEqual(parseRegisterKricCapitalTimetableArgs(["--operation-directory", "/tmp/op"]), { operationDirectory: "/tmp/op" });
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-capital-register-"));
  try {
    await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
    const lineIds = [...new Set(KRIC_CAPITAL_ROUTE_PROFILES.map(({ lineId }) => lineId))];
    await writeFile(path.join(root, "tools/datapack/source-inventory.json"), `${JSON.stringify({ sources: [{ id: "kric-nationwide-timetable-file" }] }, null, 2)}\n`);
    await writeFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), JSON.stringify({ activeLineScopes: lineIds.map((lineId) => ({ regionId: "capital", operatorId: "op", lineId })) }));
    const operationDirectory = path.join(root, "operation");
    await mkdir(operationDirectory);
    const collectedAt = new Date("2026-10-09T15:00:00.000Z");
    const clockTimes = [collectedAt, new Date("2026-10-09T15:02:00.000Z")];
    const calls = [];
    const observed = [];
    const result = await registerKricCapitalTimetable({
      repositoryRoot: root, operationDirectory, clock: () => clockTimes.shift(),
      fetchImpl: async (url, init) => { calls.push({ url, method: init.method }); return new Response(MINIMAL_XLSX, { status: 200, headers: XLSX_HEADERS }); },
      observe: async ({ inputFile, receipt }) => { observed.push({ inputFile, receipt }); return syntheticObservation(receipt); },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(observed[0].receipt.capturedAt, collectedAt.toISOString());
    assert.equal(observed[0].receipt.sha256, createHash("sha256").update(MINIMAL_XLSX).digest("hex"));
    assert.equal(path.dirname(observed[0].inputFile), operationDirectory);
    assert.equal(result.evidence.observedAt, collectedAt.toISOString());
    assert.equal(result.evidence.reverifications.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const XLSX_HEADERS = {
  "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "content-disposition": "attachment; filename=urban-timetable.xlsx",
};
const MINIMAL_XLSX = (() => {
  const names = ["[Content_Types].xml", "xl/workbook.xml"];
  let offset = 0;
  const locals = names.map((name) => {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.concat([header, filename]);
    const value = { filename, offset, entry };
    offset += entry.length;
    return value;
  });
  const central = locals.map(({ filename, offset: localOffset }) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(localOffset, 42);
    return Buffer.concat([header, filename]);
  });
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(names.length, 8); eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals.map(({ entry }) => entry), centralBytes, eocd]);
})();

function syntheticObservation(receipt) {
  let rowNumber = 1;
  const records = KRIC_CAPITAL_ROUTE_PROFILES.map(({ routeNumber, routeName }) => {
    rowNumber += 1;
    return {
      trainNumber: "1", routeNumber, routeName, originStationName: "o", destinationStationName: "d", serviceType: "일반", weekdayType: "평일",
      stationName: "001-가+002-나", arrivalTime: { value: "001-00:00+002-05:32", cellType: "s" }, departureTime: { value: "001-05:30+002-00:00", cellType: "s" },
      dataReferenceDate: { value: "46022", cellType: "n" }, sourceRowNumber: rowNumber, sourceRowSha256: createHash("sha256").update(`row-${rowNumber}`).digest("hex"),
    };
  });
  return { schemaVersion: 1, artifactKind: "kric-nationwide-timetable-observation", sourceId: "kric-nationwide-timetable-file",
    observedAt: receipt.capturedAt, rawFile: receipt.rawFile, rawByteLength: receipt.byteLength, rawSha256: receipt.sha256,
    rowCount: records.length, records, recordsSha256: "d".repeat(64) };
}
