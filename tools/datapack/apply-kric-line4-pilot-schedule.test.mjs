import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { validateKricLine4PilotCollectionArtifact } from "./apply-kric-line4-pilot-schedule.mjs";

test("KRIC pilot artifact는 명시적인 허용 sourceId를 요구한다", () => {
  assert.throws(
    () => validateKricLine4PilotCollectionArtifact({ artifactKind: "kric-line4-timetable-collection" }),
    /sourceId is required/,
  );
  assert.throws(
    () => validateKricLine4PilotCollectionArtifact({
      artifactKind: "kric-line4-timetable-collection",
      sourceId: "untrusted-source",
    }),
    /sourceId mismatch/,
  );
});

// #862 QA 결정(2026-10-01): 4호선 시각표 개정(급행 번호 변경·급행 표시 제거·평일 12편/휴일 10편 감소)을
// 새 기준으로 승인한다. 고정 건수는 2026-10-01 관측값이고, 8월 기준 건수는 더 이상 통과하지 않는다.
function syntheticCollection({ intermediate, outside, nonStop, reconstruction, trips, stopTimes }) {
  const responses = Array.from({ length: 153 }, (_, index) => {
    const bytes = Buffer.from(JSON.stringify({ header: { resultCode: "00" }, index }));
    return { requestKey: `subwayTimetableExp|S1|${index}|8`, rawSha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, bodyBase64: bytes.toString("base64") };
  });
  return {
    artifactKind: "kric-line4-timetable-collection", sourceId: "kric-subway-route-info", lineId: "seoul-4",
    operation: "subwayTimetableExp", collectedAt: "2026-10-01T03:57:13.955Z", capturedAt: "2026-10-01",
    requestCount: 153, failedRequestCount: 0, expectedNoDataRequestCount: 51,
    intermediateRowCount: intermediate, excludedOutsidePilotGroupCount: outside, excludedNonStopRowCount: nonStop,
    reconstructionRowCount: reconstruction, transitTripCount: trips, transitStopTimeCount: stopTimes,
    rawResponseInventory: { responseCount: 153, inventorySha256: createHash("sha256").update(JSON.stringify(responses)).digest("hex"), responses },
    excludedOutsidePilotGroups: Array.from({ length: outside }, () => ({})),
    excludedNonStopRows: Array.from({ length: nonStop }, () => ({})),
    transitTrips: Array.from({ length: trips }, () => ({})),
    transitStopTimes: Array.from({ length: stopTimes }, () => ({})),
  };
}

test("KRIC pilot artifact 고정 건수는 2026-10-01 승인 관측값이다(#862)", () => {
  assert.doesNotThrow(() => validateKricLine4PilotCollectionArtifact(syntheticCollection({
    intermediate: 32677, outside: 415, nonStop: 42, reconstruction: 21645, trips: 458, stopTimes: 21645,
  })));
  assert.throws(() => validateKricLine4PilotCollectionArtifact(syntheticCollection({
    intermediate: 33062, outside: 429, nonStop: 42, reconstruction: 22004, trips: 466, stopTimes: 22004,
  })), /intermediateRowCount mismatch/);
});
