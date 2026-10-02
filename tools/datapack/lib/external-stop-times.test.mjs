import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTERNAL_STOP_TIMES_KEY,
  OFFICIAL_STOP_TIMES_PATH,
  buildExternalStopTimesArtifact,
  expandExternalStopTimes,
} from "./external-stop-times.mjs";

const HEADER = Object.freeze({
  sourceId: "official-source", sourceSnapshotId: "official-source-snap", evidenceHash: "b".repeat(64),
  provenanceKind: "OFFICIAL_SOURCE", derivationKind: "OFFICIAL", updatedAt: "2026-10-02T15:57:05.773Z",
});
const trip = (id, overrides = {}) => ({
  id, routeId: "route-x", serviceId: "svc", tripHeadsign: "끝", directionId: "", servicePattern: "LOCAL", serviceClass: "SUBWAY",
  serviceDayStartSeconds: 0, ...HEADER, providerRecordHash: `${id}-hash`, ...overrides,
});
const stop = (tripId, stopSequence, stationId) => ({
  tripId, stopSequence, stationId, lineId: "line-x", arrivalSeconds: 21_600 + stopSequence * 60,
  departureSeconds: 21_630 + stopSequence * 60, pickupType: 0, dropOffType: 0,
});
// 행 provenance를 가진 원천(인천처럼 stop_time에 trip과 같은 provenance를 복제한 원천)
const copySource = { ...HEADER, sourceId: "row-copy-source", sourceSnapshotId: "row-copy-snap" };
const copyTrip = trip("c-1", copySource);
const copyStop = (sequence, stationId) => ({ ...stop("c-1", sequence, stationId), ...copySource, providerRecordHash: copyTrip.providerRecordHash });
const inlineTrip = { id: "inline-1", routeId: "route-y", serviceId: "svc", sourceId: "inline-source" };
const inlineStop = { tripId: "inline-1", stopSequence: 1, stationId: "s-z", lineId: "line-y", arrivalSeconds: 1, departureSeconds: 1, pickupType: 0, dropOffType: 0, stopHeadsign: "z", sourceId: "inline-source" };

const TRIPS = [trip("t-2"), inlineTrip, trip("t-1"), copyTrip];
const STOPS = [stop("t-2", 2, "s-b"), stop("t-1", 1, "s-a"), inlineStop, copyStop(1, "s-a"), stop("t-2", 1, "s-a"), copyStop(2, "s-b"), stop("t-1", 2, "s-b")];
const SOURCES = ["official-source", "row-copy-source"];
const build = (overrides = {}) => buildExternalStopTimesArtifact({ trips: TRIPS, stopTimes: STOPS, sourceIds: SOURCES, ...overrides });

function written(artifact) {
  const fixture = { manifest: {}, packs: [{ id: "nationwide", transitTrips: artifact.inlineTrips, transitStopTimes: artifact.inlineStopTimes, [EXTERNAL_STOP_TIMES_KEY]: artifact.binding }] };
  return { fixture, readBytes: (relative) => { assert.equal(relative, OFFICIAL_STOP_TIMES_PATH); return artifact.bytes; } };
}
const byId = (rows, key) => new Map(rows.map((row) => [key(row), row]));
const stopKey = ({ tripId, stopSequence }) => `${tripId}:${stopSequence}`;

test("같은 trip·stop_time이면 입력 순서와 상관없이 같은 gzip 바이트·sha가 나온다(mtime 0·고정 레벨)", () => {
  const first = build();
  const second = build({ trips: [...TRIPS].reverse(), stopTimes: [...STOPS].reverse() });
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.binding.sha256, second.binding.sha256);
  assert.equal(first.bytes.readUInt32LE(4), 0, "gzip header mtime must be 0");
  assert.deepEqual(first.binding.sections.map(({ sourceId, stopTimeProvenance, tripCount, stopTimeCount }) => [sourceId, stopTimeProvenance, tripCount, stopTimeCount]),
    [["official-source", "TRIP_INHERITED", 2, 4], ["row-copy-source", "ROW_COPY", 1, 2]]);
  assert.deepEqual(first.inlineTrips, [inlineTrip]);
  assert.deepEqual(first.inlineStopTimes, [inlineStop]);
});

test("펼치면 원래 trip·stop_time 객체가 provenance까지 그대로 복원되고 결속 키는 사라진다", () => {
  const { fixture, readBytes } = written(build());
  const pack = expandExternalStopTimes(fixture, { readBytes }).packs[0];
  assert.equal(Object.hasOwn(pack, EXTERNAL_STOP_TIMES_KEY), false);
  assert.deepEqual(byId(pack.transitTrips, ({ id }) => id), byId(TRIPS, ({ id }) => id));
  assert.deepEqual(byId(pack.transitStopTimes, stopKey), byId(STOPS, stopKey));
  const plain = { packs: [{ transitStopTimes: [inlineStop] }] };
  assert.equal(expandExternalStopTimes(plain, { readBytes }), plain);
});

test("원천 공통 provenance가 trip마다 다르거나 모르는 필드·provenance 누락이 있으면 떼어내지 않고 실패한다", () => {
  assert.throws(() => build({ trips: [trip("t-2"), trip("t-1", { updatedAt: "2026-10-03T00:00:00.000Z" }), copyTrip, inlineTrip] }), /TRIP_HEADER_MISMATCH: t-1 updatedAt/u);
  assert.throws(() => build({ trips: [trip("t-2"), trip("t-1", { lineId: "line-x" }), copyTrip, inlineTrip] }), /TRIP_SHAPE: t-1/u);
  assert.throws(() => build({ trips: [trip("t-2"), trip("t-1", { providerRecordHash: "" }), copyTrip, inlineTrip] }), /TRIP_PROVENANCE_MISSING: t-1/u);
  const mismatchedRow = { ...copyStop(2, "s-b"), providerRecordHash: "other" };
  assert.throws(() => build({ stopTimes: [...STOPS.filter((row) => !(row.tripId === "c-1" && row.stopSequence === 2)), mismatchedRow] }), /STOP_TIME_SHAPE: c-1:2/u);
  const mixed = [...STOPS.filter((row) => !(row.tripId === "c-1" && row.stopSequence === 2)), stop("c-1", 2, "s-b")];
  assert.throws(() => build({ stopTimes: mixed }), /STOP_TIME_PROVENANCE_MIXED: row-copy-source/u);
});

test("고아 stop_time·stop_time 없는 trip·대상 원천 trip 0은 실패한다", () => {
  assert.throws(() => build({ stopTimes: [...STOPS, { ...stop("ghost", 1, "s-a"), sourceId: "official-source" }] }), /ORPHAN_STOP_TIME: ghost/u);
  assert.throws(() => build({ trips: [...TRIPS, trip("t-3")] }), /TRIP_WITHOUT_STOP_TIMES: t-3/u);
  assert.throws(() => build({ sourceIds: [...SOURCES, "missing-source"] }), /SOURCE_HAS_NO_TRIPS: missing-source/u);
});

test("파일 바이트·결속 요약이 다르거나 펼친 행이 팩 행과 겹치면 실패한다", () => {
  const artifact = build();
  const tampered = Buffer.from(artifact.bytes);
  tampered[tampered.length - 5] ^= 0xff;
  assert.throws(() => expandExternalStopTimes(written(artifact).fixture, { readBytes: () => tampered }), /SHA256_MISMATCH/u);
  const wrongCount = { ...artifact, binding: { ...artifact.binding, sections: [{ ...artifact.binding.sections[0], stopTimeCount: 3 }, artifact.binding.sections[1]] } };
  assert.throws(() => expandExternalStopTimes(written(wrongCount).fixture, { readBytes: () => artifact.bytes }), /BINDING_MISMATCH/u);
  const duplicateTrip = { ...artifact, inlineTrips: [...artifact.inlineTrips, trip("t-1")] };
  assert.throws(() => expandExternalStopTimes(written(duplicateTrip).fixture, { readBytes: () => artifact.bytes }), /TRIP_DUPLICATE: t-1/u);
  const duplicateStop = { ...artifact, inlineStopTimes: [...artifact.inlineStopTimes, stop("t-1", 1, "s-a")] };
  assert.throws(() => expandExternalStopTimes(written(duplicateStop).fixture, { readBytes: () => artifact.bytes }), /DUPLICATE_STOP_TIME/u);
});
