import assert from "node:assert/strict";
import test from "node:test";

import { resolveCapitalTimetableObservation } from "./capital-official-timetable.mjs";

// #870: 수도권 snapshot은 관측 시각과 무관하다. 관측 시각은 inventory evidence의 append-only 재확인 이력이 정한다.
const RAW = "a".repeat(64);
const RECORDS = "b".repeat(64);
const snapshot = Object.freeze({ snapshotId: `kric-nationwide-timetable-file-capital-${RECORDS}`, rawSha256: RAW, recordsSha256: RECORDS });
const entry = (observedAt, rawSha256 = RAW) => ({ observedAt, rawSha256, collectionReceiptSha256: "c".repeat(64) });
const evidence = (overrides = {}) => ({
  snapshotId: snapshot.snapshotId, rawSha256: RAW, recordsSha256: RECORDS, observedAt: "2026-10-09T15:00:00.000Z",
  reverifications: [entry("2026-10-02T15:57:05.773Z", "d".repeat(64)), entry("2026-10-03T15:00:00.000Z"), entry("2026-10-09T15:00:00.000Z")],
  ...overrides,
});

test("신선도 기준 관측 시각은 evidence의 최신 재확인 observedAt이다", () => {
  assert.equal(resolveCapitalTimetableObservation({ evidence: evidence(), snapshot }), "2026-10-09T15:00:00.000Z");
});

test("evidence 관측 시각·재확인 이력·snapshot 결속이 어긋나면 실패한다", () => {
  const cases = [
    [evidence({ observedAt: "2026-10-03T15:00:00.000Z" }), /OBSERVATION/u],
    [evidence({ reverifications: [] }), /REVERIFICATIONS/u],
    [evidence({ reverifications: [entry("2026-10-09T15:00:00.000Z"), entry("2026-10-03T15:00:00.000Z")] }), /REVERIFICATIONS/u],
    [evidence({ reverifications: [entry("2026-10-03T15:00:00.000Z"), entry("2026-10-09T15:00:00.000Z", "e".repeat(64))] }), /REVERIFICATIONS/u],
    [evidence({ reverifications: [entry("2026-10-03T15:00:00.000Z"), { ...entry("2026-10-09T15:00:00.000Z"), note: "x" }] }), /REVERIFICATIONS/u],
    [evidence({ recordsSha256: "f".repeat(64) }), /SNAPSHOT/u],
    [evidence({ snapshotId: "other" }), /SNAPSHOT/u],
    [evidence({ rawSha256: "e".repeat(64) }), /SNAPSHOT/u],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => resolveCapitalTimetableObservation({ evidence: value, snapshot }), pattern, JSON.stringify(value).slice(0, 120));
  }
});
