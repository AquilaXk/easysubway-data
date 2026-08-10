import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildItxCurrentTopologyAdmission } from "./build-itx-current-topology-admission.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function sequence(directionId, stationIds) {
  return {
    directionId,
    stops: stationIds.map((stationId) => ({ stationId })),
  };
}

function fixture() {
  const stationSequences = [
    sequence("up", ["station-a", "station-b", "station-c"]),
    sequence("down", ["station-c", "station-b", "station-a"]),
  ];
  const reconstructionSummary = {
    conflictingTimestampCount: 0,
    missingPairCount: 0,
    duplicateOdCount: 0,
  };
  const operations = [{
    operation: "GetStrtpntAlocFndTrainInfo",
    providerResultCode: "00",
    schemaStatus: "EXPECTED",
    requestCount: 1,
    pageCount: 1,
    totalCount: 1,
    rawResponseSha256: "3".repeat(64),
  }];
  const collection = {
    schemaVersion: 2,
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    serviceId: "ITX_CHEONGCHUN",
    observedAt: "2026-08-09T14:19:07.643Z",
    validationStatus: "MISSING",
    admissionStatus: "MISSING",
    credentialRedacted: true,
    selectedServiceDates: { "8": "20260810", "7": "20260815", "9": "20260809" },
    serviceDays: [{
      dayCd: "8",
      serviceDate: "20260810",
      status: "SUPPORTED",
      expectedOdCount: 306,
      completedOdCount: 306,
      failedOdCount: 0,
      stationSetHash: "4".repeat(64),
      odMatrixHash: "5".repeat(64),
      reconstructionSummary,
      roster: {
        schemaVersion: 2,
        artifactKind: "tago-itx-cheongchun-roster-evidence",
        serviceDate: "20260810",
        kricServiceDayCode: "8",
        expectedOdCount: 306,
        completedOdCount: 306,
        failedOdCount: 0,
        reconstructionSummary,
        operations,
        stationSequences,
      },
    }, {
      dayCd: "7",
      serviceDate: "20260815",
      status: "MISSING",
      failureStage: "OD_MATERIALIZATION",
      failureReasonCode: "OD_MATRIX_INCOMPLETE",
    }, {
      dayCd: "9",
      serviceDate: "20260809",
      status: "MISSING",
      failureStage: "OD_MATERIALIZATION",
      failureReasonCode: "OD_MATRIX_INCOMPLETE",
    }],
  };
  const previousSource = {
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-source-timetable",
    serviceId: "ITX_CHEONGCHUN",
    artifactId: "itx-cheongchun-source-timetable-previous",
    validationStatus: "SUPPORTED",
    stationSequences: structuredClone(stationSequences),
  };
  return { collection, previousSource };
}

test("current weekday OD pair가 previous admission과 exact 같으면 topology-only admission을 만든다", () => {
  const values = fixture();
  const collectionBytes = Buffer.from(JSON.stringify(values.collection));
  const previousBytes = Buffer.from(JSON.stringify(values.previousSource));
  const result = buildItxCurrentTopologyAdmission({
    collection: values.collection,
    collectionSha256: sha256(collectionBytes),
    previousSource: values.previousSource,
    previousSha256: sha256(previousBytes),
  });

  assert.equal(result.artifactKind, "itx-current-network-edge-admission");
  assert.equal(result.status, "ADMITTED");
  assert.equal(result.serviceDate, "20260810");
  assert.equal(result.freshUntil, "2026-08-11T00:00:00+09:00");
  assert.equal(result.scheduleAdmissionStatus, "MISSING");
  assert.equal(result.pairHashes.length, 4);
  assert.match(result.evidenceHash, /^[a-f0-9]{64}$/);
});

test("current weekday canonical station set이 previous admission과 다르면 topology admission을 만들지 않는다", () => {
  const values = fixture();
  values.collection.serviceDays[0].roster.stationSequences[0].stops[1].stationId = "station-x";
  assert.throws(() => buildItxCurrentTopologyAdmission({
    collection: values.collection,
    collectionSha256: "6".repeat(64),
    previousSource: values.previousSource,
    previousSha256: "7".repeat(64),
  }), /canonical station set mismatch/);
});

test("current weekday는 up/down sequence를 정확히 하나씩만 허용한다", () => {
  const values = fixture();
  values.collection.serviceDays[0].roster.stationSequences.push(
    structuredClone(values.collection.serviceDays[0].roster.stationSequences[1]),
  );
  assert.throws(() => buildItxCurrentTopologyAdmission({
    collection: values.collection,
    collectionSha256: "6".repeat(64),
    previousSource: values.previousSource,
    previousSha256: "7".repeat(64),
  }), /must contain exactly one up and one down station sequence/);
});

test("station set이 같고 pair가 다르면 previous pair를 유지한 admission에 drift를 명시한다", () => {
  const values = fixture();
  values.collection.serviceDays[0].roster.stationSequences = [
    sequence("up", ["station-a", "station-c", "station-b"]),
    sequence("down", ["station-b", "station-c", "station-a"]),
  ];
  const result = buildItxCurrentTopologyAdmission({
    collection: values.collection,
    collectionSha256: "6".repeat(64),
    previousSource: values.previousSource,
    previousSha256: "7".repeat(64),
  });

  assert.equal(result.status, "ADMITTED");
  assert.equal(result.topologyMode, "UNCHANGED_AUTO_STATION_SET");
  assert.ok(result.observedPairChange.addedCount > 0);
  assert.ok(result.observedPairChange.removedCount > 0);
  assert.notEqual(result.observedPairSetSha256, result.admittedPairSetSha256);
});
