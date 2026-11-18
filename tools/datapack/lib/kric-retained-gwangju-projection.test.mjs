import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  DAEJEON_LINE_ID,
  DAEJEON_ROUTE_NUMBER,
  RETAINED_DAEJEON_PROJECTION_EVIDENCE_KEY,
  RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY,
  buildRetainedDaejeonScheduleTables,
  projectRetainedDaejeonRecords,
  projectRetainedGwangjuRecords,
  retainedDaejeonProjectionEvidence,
  retainedGwangjuProjectionEvidence,
  validateRetainedDaejeonProjection,
  validateRetainedGwangjuProjection,
} from "./kric-retained-gwangju-projection.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const RETAINED = {
  snapshotId: "kric-nationwide-timetable-file-retained",
  observedAt: "2026-10-01T04:19:25.298Z",
  recordsSha256: "a".repeat(64),
  observationIdentitySha256: "d".repeat(64),
};
const record = (routeNumber, sourceRowNumber) => ({ routeNumber, trainNumber: `${sourceRowNumber}`, sourceRowNumber });

function retained() {
  return {
    observation: { records: [record("S2901", 2), record("I4108", 3), record("S2901", 4)] },
    routeNumber: "S2901",
  };
}

function daejeonRecord(trainNumber, sourceRowNumber, overrides = {}) {
  return {
    trainNumber,
    routeNumber: DAEJEON_ROUTE_NUMBER,
    routeName: "대전 도시철도 1호선",
    originStationName: "판암",
    destinationStationName: "대동",
    serviceType: "일반",
    weekdayType: "평일",
    stationName: "001-판암+002-신흥+003-대동",
    arrivalTime: { value: "", cellType: "n", styleId: 63 },
    departureTime: { value: "001-05:30+002-05:32+003-05:35", cellType: "s", styleId: 38 },
    sourceRowNumber,
    sourceRowSha256: sha(`${trainNumber}:${sourceRowNumber}`),
    ...overrides,
  };
}

function retainedDaejeon() {
  return {
    observation: {
      records: [
        daejeonRecord("1002", 20, {
          weekdayType: "휴일",
          originStationName: "대동",
          destinationStationName: "판암",
          stationName: "001-대동+002-신흥+003-판암",
          departureTime: { value: "001-23:55+002-23:58+003-00:00", cellType: "s", styleId: 38 },
        }),
        record("S2901", 10),
        daejeonRecord("1001", 15),
      ],
    },
    routeNumber: DAEJEON_ROUTE_NUMBER,
  };
}

test("보관본 관측에서 계약 노선 행만 원문 그대로 골라 결정적 projection을 만든다", () => {
  const snapshot = projectRetainedGwangjuRecords({ retained: retained(), retainedEvidence: RETAINED, observationRawObjectSha256: "b".repeat(64) });
  assert.deepEqual(snapshot.records.map(({ sourceRowNumber }) => sourceRowNumber), [2, 4]);
  assert.equal(snapshot.recordCount, 2);
  assert.equal(snapshot.recordsSha256, sha(`${JSON.stringify(snapshot.records)}\n`));
  assert.equal(snapshot.retainedSnapshotId, RETAINED.snapshotId);
  assert.equal(snapshot.observedAt, RETAINED.observedAt);
  assert.match(snapshot.snapshotId, /^kric-nationwide-timetable-file-gwangju-[a-f0-9]{64}$/u);
  // 스냅샷 식별자는 projection 본문의 독립 계산 해시와 같아야 한다(입력 순서와 무관한 결정적 바이트).
  const { snapshotId, contentSha256, ...body } = snapshot;
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
      : JSON.stringify(value);
  assert.equal(contentSha256, sha(canonical(body)));
  assert.equal(snapshotId, `kric-nationwide-timetable-file-gwangju-${contentSha256}`);
  assert.throws(() => projectRetainedGwangjuRecords({ retained: { ...retained(), routeNumber: "S9999" }, retainedEvidence: RETAINED, observationRawObjectSha256: "b".repeat(64) }),
    /RETAINED_GWANGJU_PROJECTION_ROUTE_EMPTY/u);
});

test("projection은 내용 해시·inventory evidence·현재 보관본 head와 모두 맞을 때만 통과한다", () => {
  const snapshot = projectRetainedGwangjuRecords({ retained: retained(), retainedEvidence: RETAINED, observationRawObjectSha256: "b".repeat(64) });
  const evidence = retainedGwangjuProjectionEvidence(snapshot);
  assert.equal(RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY, "retainedGwangjuProjectionEvidence");
  assert.equal(evidence.snapshotPath, `tools/datapack/sources/${snapshot.snapshotId}.json`);
  const HEAD = { snapshotId: RETAINED.snapshotId, rawObjectSha256: "b".repeat(64) };
  assert.deepEqual(validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence: RETAINED, retainedHead: HEAD }), snapshot);

  const tampered = structuredClone(snapshot);
  tampered.records[0].trainNumber = "x";
  assert.throws(() => validateRetainedGwangjuProjection({ snapshot: tampered, evidence, retainedEvidence: RETAINED, retainedHead: HEAD }), /RETAINED_GWANGJU_PROJECTION_CONTENT/u);
  for (const change of [{ snapshotId: "other" }, { contentSha256: "0".repeat(64) }, { recordCount: 3 }, { retainedSnapshotId: "old" }]) {
    assert.throws(() => validateRetainedGwangjuProjection({ snapshot, evidence: { ...evidence, ...change }, retainedEvidence: RETAINED, retainedHead: HEAD }),
      /RETAINED_GWANGJU_PROJECTION_EVIDENCE/u);
  }
  // 보관본 head가 갱신됐는데 projection을 다시 만들지 않았으면 실패한다.
  assert.throws(() => validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence: { ...RETAINED, snapshotId: "kric-nationwide-timetable-file-newer" },
    retainedHead: { ...HEAD, snapshotId: "kric-nationwide-timetable-file-newer" } }), /RETAINED_GWANGJU_PROJECTION_STALE/u);

  // 리뷰 F3: snapshot과 evidence를 함께 바꿔 내부 해시를 다시 맞춰도, 원장 head의 관측 객체 sha와 다르면 실패한다.
  const forged = projectRetainedGwangjuRecords({ retained: retained(), retainedEvidence: RETAINED, observationRawObjectSha256: "c".repeat(64) });
  assert.throws(() => validateRetainedGwangjuProjection({ snapshot: forged, evidence: retainedGwangjuProjectionEvidence(forged), retainedEvidence: RETAINED, retainedHead: HEAD }),
    /RETAINED_GWANGJU_PROJECTION_LEDGER/u);
  assert.throws(() => validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence: RETAINED, retainedHead: { ...HEAD, snapshotId: "other" } }),
    /RETAINED_GWANGJU_PROJECTION_LEDGER/u);
});

test("대전 보관본 projection은 S3001 행만 골라 현재 보관본 head에 결속하고 변조를 거부한다", () => {
  const snapshot = projectRetainedDaejeonRecords({ retained: retainedDaejeon(), retainedEvidence: RETAINED, observationRawObjectSha256: "b".repeat(64) });
  assert.deepEqual(snapshot.records.map(({ sourceRowNumber }) => sourceRowNumber), [15, 20]);
  assert.equal(snapshot.recordCount, 2);
  assert.equal(snapshot.routeNumber, DAEJEON_ROUTE_NUMBER);
  assert.match(snapshot.snapshotId, /^kric-nationwide-timetable-file-daejeon-[a-f0-9]{64}$/u);
  const evidence = retainedDaejeonProjectionEvidence(snapshot);
  assert.equal(RETAINED_DAEJEON_PROJECTION_EVIDENCE_KEY, "retainedDaejeonProjectionEvidence");
  assert.equal(evidence.snapshotPath, `tools/datapack/sources/${snapshot.snapshotId}.json`);
  const HEAD = { snapshotId: RETAINED.snapshotId, rawObjectSha256: "b".repeat(64) };
  assert.deepEqual(validateRetainedDaejeonProjection({ snapshot, evidence, retainedEvidence: RETAINED, retainedHead: HEAD }), snapshot);

  const tampered = structuredClone(snapshot);
  tampered.records[0].trainNumber = "9999";
  assert.throws(() => validateRetainedDaejeonProjection({ snapshot: tampered, evidence, retainedEvidence: RETAINED, retainedHead: HEAD }), /RETAINED_DAEJEON_PROJECTION_CONTENT/u);
  assert.throws(() => validateRetainedDaejeonProjection({ snapshot, evidence: { ...evidence, recordCount: 99 }, retainedEvidence: RETAINED, retainedHead: HEAD }),
    /RETAINED_DAEJEON_PROJECTION_EVIDENCE/u);
  assert.throws(() => validateRetainedDaejeonProjection({ snapshot, evidence, retainedEvidence: { ...RETAINED, snapshotId: "kric-nationwide-timetable-file-newer" },
    retainedHead: { ...HEAD, snapshotId: "kric-nationwide-timetable-file-newer" } }), /RETAINED_DAEJEON_PROJECTION_STALE/u);
  assert.throws(() => validateRetainedDaejeonProjection({ snapshot, evidence, retainedEvidence: RETAINED, retainedHead: { ...HEAD, rawObjectSha256: "c".repeat(64) } }),
    /RETAINED_DAEJEON_PROJECTION_LEDGER/u);
});

test("대전 KRIC 열차별 시간표 조립은 종착역 정차와 자정 이후(00:00=86400초, 00:02=86520초) 도착을 공식 시각으로 만들고 시각 역전 행을 격리한다", () => {
  const finalPack = {
    stations: [
      { id: "station-panam", nameKo: "판암" },
      { id: "station-sinheung", nameKo: "신흥" },
      { id: "station-daedong", nameKo: "대동" },
    ],
    stationLines: [
      { stationId: "station-panam", lineId: DAEJEON_LINE_ID, lineSequence: 1 },
      { stationId: "station-sinheung", lineId: DAEJEON_LINE_ID, lineSequence: 2 },
      { stationId: "station-daedong", lineId: DAEJEON_LINE_ID, lineSequence: 3 },
    ],
  };
  const baseRecords = retainedDaejeon().observation.records;
  baseRecords[0].departureTime.value = "001-23:58+002-00:00+003-00:02";
  const snapshot = projectRetainedDaejeonRecords({ retained: { observation: { records: baseRecords }, routeNumber: DAEJEON_ROUTE_NUMBER }, retainedEvidence: RETAINED, observationRawObjectSha256: "b".repeat(64) });
  const tables = buildRetainedDaejeonScheduleTables({ records: snapshot.records, retainedEvidence: RETAINED, finalPack });
  assert.equal(tables.transitTrips.length, 2);
  assert.equal(tables.transitStopTimes.length, 6);
  assert.deepEqual(tables.nonRoutableGroups, []);

  const weekdayTrip = tables.transitTrips.find(({ id }) => id === "trip-S3001-평일-1001");
  const holidayTrip = tables.transitTrips.find(({ id }) => id === "trip-S3001-휴일-1002");
  assert.equal(weekdayTrip.routeId, "route-daejeon-line-1");
  assert.equal(weekdayTrip.serviceId, "daejeon-weekday-2026");
  assert.equal(weekdayTrip.tripHeadsign, "대동");
  assert.equal(weekdayTrip.directionId, "down");
  assert.equal(holidayTrip.serviceId, "daejeon-holiday-2026");
  assert.equal(holidayTrip.tripHeadsign, "판암");
  assert.equal(holidayTrip.directionId, "up");

  const holidayStops = tables.transitStopTimes.filter(({ tripId }) => tripId === "trip-S3001-휴일-1002");
  assert.deepEqual(holidayStops.map(({ stopSequence, stationId, arrivalSeconds, departureSeconds, pickupType, dropOffType }) => ({
    stopSequence, stationId, arrivalSeconds, departureSeconds, pickupType, dropOffType,
  })), [
    { stopSequence: 1, stationId: "station-daedong", arrivalSeconds: 86_280, departureSeconds: 86_280, pickupType: 0, dropOffType: 1 },
    { stopSequence: 2, stationId: "station-sinheung", arrivalSeconds: 86_400, departureSeconds: 86_400, pickupType: 0, dropOffType: 0 },
    { stopSequence: 3, stationId: "station-panam", arrivalSeconds: 86_520, departureSeconds: 86_520, pickupType: 1, dropOffType: 0 },
  ]);

  const nonMonotonic = daejeonRecord("1211", 25, {
    weekdayType: "휴일",
    departureTime: { value: "001-23:16+002-23:18+003-23:09", cellType: "s", styleId: 38 },
  });
  const withQuarantine = buildRetainedDaejeonScheduleTables({
    records: [...snapshot.records, nonMonotonic],
    retainedEvidence: RETAINED,
    finalPack,
  });
  assert.equal(withQuarantine.transitTrips.length, 2);
  assert.equal(withQuarantine.nonRoutableGroups.length, 1);
  assert.equal(withQuarantine.nonRoutableGroups[0].reason, "TIME_NOT_MONOTONIC");
  assert.equal(withQuarantine.nonRoutableGroups[0].identity.trainNumber, "1211");

  assert.throws(() => buildRetainedDaejeonScheduleTables({
    records: [nonMonotonic, { ...nonMonotonic, trainNumber: "1212", sourceRowNumber: 26, sourceRowSha256: sha("1212:26") }],
    retainedEvidence: RETAINED,
    finalPack,
  }), /RETAINED_DAEJEON_SCHEDULE_QUARANTINE_LIMIT/u);

  assert.throws(() => buildRetainedDaejeonScheduleTables({
    records: [daejeonRecord("1003", 30, {
      originStationName: "판암",
      destinationStationName: "대동",
      stationName: "001-판암+002-대동",
      departureTime: { value: "001-05:30+002-05:35", cellType: "s", styleId: 38 },
    })],
    retainedEvidence: RETAINED,
    finalPack,
  }), /DAEJEON_NON_ADJACENT_STOPS/u);
});


