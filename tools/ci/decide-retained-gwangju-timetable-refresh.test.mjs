import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { decideRetainedGwangjuTimetableRefresh, readRetainedGwangjuTimetableRefreshDecision } from "./decide-retained-gwangju-timetable-refresh.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";
const OBSERVED_AT = "2026-09-07T10:50:18.169Z";
const EXPIRY = "2026-09-14T10:50:18.169Z";
const rawSha256 = "a".repeat(64);
const observationIdentitySha256 = "b".repeat(64);
const snapshotId = `${SOURCE_ID}-${observationIdentitySha256}`;

function candidate(cadence = "P7D") {
  return {
    id: SOURCE_ID,
    domain: "schedule_timetable",
    confirmationPolicy: {
      id: "official_static_timetable_confirmation",
      sourceIds: [SOURCE_ID], basisField: "observedAt", reverificationCadence: cadence,
      futureBasisAllowed: false, eventTriggers: ["official timetable revision notice"],
      providerValidityEndField: "serviceEffectiveUntil",
    },
  };
}

function snapshot(overrides = {}) {
  return {
    snapshotId, sourceId: SOURCE_ID, previousSnapshotId: null,
    observedAt: OBSERVED_AT, capturedAt: OBSERVED_AT, retrievedAt: OBSERVED_AT,
    sourceUpdatedAt: null, rowCount: 1, coverageCount: 1, rawSha256,
    contentSha256: observationIdentitySha256, schemaFingerprint: "c".repeat(64),
    redactedRequestFingerprint: "d".repeat(64), diffSummary: null,
    freshnessExpiresAt: EXPIRY, freshUntil: EXPIRY,
    ...overrides,
  };
}

function inputs({ head = snapshot(), source = {} } = {}) {
  return {
    candidate: candidate(), snapshots: [head],
    inventory: { sources: [{ id: SOURCE_ID, retainedScheduleAdmissionEvidence: {
      snapshotId, rawSha256, observationIdentitySha256, observedAt: OBSERVED_AT,
    }, ...source }] },
  };
}

test("repository decision reads the admitted head and rejects duplicate source policy", async (t) => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "retained-refresh-decision-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const value = inputs();
  const writeJson = async (relative, data) => {
    const file = path.join(repositoryRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
  };
  await writeJson("tools/datapack/source-inventory.json", value.inventory);
  await writeJson("tools/datapack/release/source-snapshots.json", value.snapshots);
  await writeJson("tools/datapack/source-candidates.json", { candidates: [value.candidate] });
  const result = await readRetainedGwangjuTimetableRefreshDecision({ repositoryRoot, now: new Date(EXPIRY) });
  assert.equal(result.state, "DUE");
  assert.equal(result.snapshotId, snapshotId);
  await writeJson("tools/datapack/source-candidates.json", { candidates: [value.candidate, value.candidate] });
  await assert.rejects(readRetainedGwangjuTimetableRefreshDecision({ repositoryRoot, now: new Date(EXPIRY) }),
    /RETAINED_GWANGJU_TIMETABLE_REFRESH_SOURCE_CANDIDATE/);
});

test("retained Gwangju timetable은 genuine head가 아직 만료 전이면 CURRENT다", () => {
  const result = decideRetainedGwangjuTimetableRefresh({ ...inputs(), now: new Date("2026-09-10T00:00:00.000Z") });
  assert.deepEqual(result, { state: "CURRENT", sourceId: SOURCE_ID, snapshotId, observedAt: OBSERVED_AT, freshnessExpiresAt: EXPIRY });
});

test("retained Gwangju timetable은 만료 경계에서 DUE다", () => {
  const result = decideRetainedGwangjuTimetableRefresh({ ...inputs(), now: new Date(EXPIRY) });
  assert.equal(result.state, "DUE");
});

test("정책 cadence 변경은 head observedAt으로 재유도하고 stale ledger를 거부한다", () => {
  const value = inputs();
  value.candidate = candidate("P14D");
  value.snapshots[0].freshnessExpiresAt = "2026-09-21T10:50:18.169Z";
  value.snapshots[0].freshUntil = "2026-09-21T10:50:18.169Z";
  assert.equal(
    decideRetainedGwangjuTimetableRefresh({ ...value, now: new Date("2026-09-10T00:00:00.000Z") }).freshnessExpiresAt,
    "2026-09-21T10:50:18.169Z",
  );
  value.snapshots[0].freshnessExpiresAt = EXPIRY;
  value.snapshots[0].freshUntil = EXPIRY;
  assert.throws(
    () => decideRetainedGwangjuTimetableRefresh({ ...value, now: new Date("2026-09-10T00:00:00.000Z") }),
    /RETAINED_GWANGJU_TIMETABLE_REFRESH_FRESHNESS_EXPIRES_AT/,
  );
});

test("inventory evidence mismatch와 future observation을 거부한다", () => {
  const mismatch = inputs({ source: { retainedScheduleAdmissionEvidence: {
    snapshotId, rawSha256: "e".repeat(64), observationIdentitySha256, observedAt: OBSERVED_AT,
  } } });
  assert.throws(
    () => decideRetainedGwangjuTimetableRefresh({ ...mismatch, now: new Date("2026-09-10T00:00:00.000Z") }),
    /RETAINED_GWANGJU_TIMETABLE_REFRESH_HEAD_BINDING/,
  );
  const future = inputs({ head: snapshot({ observedAt: "2026-09-11T00:00:00.000Z", capturedAt: "2026-09-11T00:00:00.000Z", retrievedAt: "2026-09-11T00:00:00.000Z", freshnessExpiresAt: "2026-09-18T00:00:00.000Z", freshUntil: "2026-09-18T00:00:00.000Z" }) });
  future.inventory.sources[0].retainedScheduleAdmissionEvidence.observedAt = "2026-09-11T00:00:00.000Z";
  assert.throws(
    () => decideRetainedGwangjuTimetableRefresh({ ...future, now: new Date("2026-09-10T00:00:00.000Z") }),
    /RETAINED_GWANGJU_TIMETABLE_REFRESH_FUTURE_OBSERVATION/,
  );
});
