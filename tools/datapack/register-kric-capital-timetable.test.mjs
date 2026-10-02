import assert from "node:assert/strict";
import test from "node:test";

import { assertAppendOnlyReverifications, planKricCapitalTimetableRegistration } from "./register-kric-capital-timetable.mjs";
import { RAW_PUBLICATION_MODE } from "./lib/same-raw-reverification.mjs";

// #870: 같은 원본(raw sha256)을 다시 수집하면 snapshot 파일을 새로 만들지 않고 재확인 이력만 append한다.
const RAW = "a".repeat(64);
const RECORDS = "b".repeat(64);
const snapshot = (rawSha256 = RAW, recordsSha256 = RECORDS) => ({ snapshotId: `kric-nationwide-timetable-file-capital-${recordsSha256}`, rawSha256, recordsSha256 });
const bytesOf = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const observation = (observedAt, collectionReceiptSha256 = "c".repeat(64)) => ({ observedAt, collectionReceiptSha256 });
const template = (value) => ({ issue: 899, snapshotId: value.snapshotId, snapshotPath: `tools/datapack/sources/${value.snapshotId}.json`, rawSha256: value.rawSha256, recordsSha256: value.recordsSha256 });
const first = () => planKricCapitalTimetableRegistration({
  previousEvidence: null, snapshot: snapshot(), snapshotBytes: bytesOf(snapshot()), existingSnapshotBytes: null,
  observation: observation("2026-10-02T15:57:05.773Z"), evidenceTemplate: template(snapshot()),
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
    observation: observation("2026-10-09T15:00:00.000Z", "d".repeat(64)), evidenceTemplate: template(snapshot()),
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
    observation: observation("2026-10-09T15:00:00.000Z"), evidenceTemplate: template(next),
  });
  assert.equal(plan.mode, RAW_PUBLICATION_MODE.PUBLISH_NEW);
  assert.equal(plan.writeSnapshot, true);
  assert.equal(plan.evidence.snapshotId, next.snapshotId);
  assert.deepEqual(plan.evidence.reverifications.slice(0, -1), previous.reverifications);
});

test("같은 원본인데 records·기존 snapshot 바이트가 다르거나, 관측 시각이 앞서지 않거나, 이력이 바뀌었으면 실패한다", () => {
  const previous = first().evidence;
  const base = { previousEvidence: previous, snapshot: snapshot(), snapshotBytes: bytesOf(snapshot()), existingSnapshotBytes: bytesOf(snapshot()),
    observation: observation("2026-10-09T15:00:00.000Z"), evidenceTemplate: template(snapshot()) };
  const changedRecords = snapshot(RAW, "9".repeat(64));
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, snapshot: changedRecords, snapshotBytes: bytesOf(changedRecords), evidenceTemplate: template(changedRecords) }), /RECORDS_MISMATCH/u);
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, existingSnapshotBytes: null }), /SNAPSHOT_MISMATCH/u);
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, existingSnapshotBytes: Buffer.from("{}\n") }), /SNAPSHOT_MISMATCH/u);
  assert.throws(() => planKricCapitalTimetableRegistration({ ...base, observation: observation("2026-10-02T15:57:05.773Z") }), /OBSERVATION_ORDER/u);
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
