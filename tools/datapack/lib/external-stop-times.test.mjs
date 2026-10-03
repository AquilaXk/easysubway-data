import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

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

// #910 F2: sha와 결속을 다시 맞춘 변조 파일도 expand가 내용 검사로 막는지 고정한다.
// 결속 요약은 테스트가 직접 고친다(제품 함수로 다시 만들지 않는다).
function reseal(artifact, mutateContent, mutateBinding = (binding) => binding) {
  const content = JSON.parse(gunzipSync(artifact.bytes).toString("utf8"));
  mutateContent(content);
  const bytes = gzipSync(Buffer.from(`${JSON.stringify(content)}\n`), { level: 9 });
  const binding = mutateBinding(structuredClone(artifact.binding));
  binding.sha256 = createHash("sha256").update(bytes).digest("hex");
  return { ...artifact, bytes, binding };
}
const officialSection = (content) => content.sections.find(({ header }) => header.sourceId === "official-source");
const expandResealed = (resealed) => expandExternalStopTimes(written(resealed).fixture, { readBytes: () => resealed.bytes });

test("sha·결속을 다시 맞춘 파일이라도 고아 stop_time·stop_time 없는 trip은 expand에서 실패한다(#910 F2)", () => {
  const artifact = build();
  // 섹션 trip에 없는 tripId의 stop_time 한 행(결속 요약은 그 행만큼 늘린다)
  const orphan = reseal(artifact, (content) => {
    officialSection(content).stopTimes.push(["ghost", 1, "s-a", "line-x", 21_660, 21_690, 0, 0, null]);
  }, (binding) => {
    const section = binding.sections.find(({ sourceId }) => sourceId === "official-source");
    section.stopTimeCount += 1;
    section.byLine["line-x"] = { tripCount: section.byLine["line-x"].tripCount + 1, stopTimeCount: section.byLine["line-x"].stopTimeCount + 1 };
    binding.stopTimeCount += 1;
    return binding;
  });
  assert.throws(() => expandResealed(orphan), /ORPHAN_STOP_TIME: ghost/u);
  // stop_time이 하나도 없는 trip 한 행(결속 trip 수만 늘린다)
  const emptyTrip = reseal(artifact, (content) => {
    officialSection(content).trips.push(["t-9", "route-x", "svc", "끝", "", "LOCAL", "SUBWAY", 0, "t-9-hash"]);
  }, (binding) => {
    binding.sections.find(({ sourceId }) => sourceId === "official-source").tripCount += 1;
    binding.tripCount += 1;
    return binding;
  });
  assert.throws(() => expandResealed(emptyTrip), /TRIP_WITHOUT_STOP_TIMES: t-9/u);
});

test("sha·결속을 다시 맞춘 파일이라도 섹션 헤더 불일치·모르는 필드·행 열 수 불일치는 expand에서 실패한다(#910 F2)", () => {
  const artifact = build();
  const extraHeader = reseal(artifact, (content) => { officialSection(content).header.lineId = "line-x"; });
  assert.throws(() => expandResealed(extraHeader), /EXTERNAL_STOP_TIMES_SECTION: official-source/u);
  const blankHeader = reseal(artifact, (content) => { officialSection(content).header.evidenceHash = ""; });
  assert.throws(() => expandResealed(blankHeader), /EXTERNAL_STOP_TIMES_SECTION: official-source/u);
  const unknownSectionField = reseal(artifact, (content) => { officialSection(content).note = "x"; });
  assert.throws(() => expandResealed(unknownSectionField), /EXTERNAL_STOP_TIMES_SECTION: official-source/u);
  const unknownTopField = reseal(artifact, (content) => { content.generatedBy = "x"; });
  assert.throws(() => expandResealed(unknownTopField), /EXTERNAL_STOP_TIMES_CONTENT/u);
  const longTripRow = reseal(artifact, (content) => { officialSection(content).trips[0].push("extra"); });
  assert.throws(() => expandResealed(longTripRow), /EXTERNAL_STOP_TIMES_ROW_SHAPE/u);
  const shortStopRow = reseal(artifact, (content) => { officialSection(content).stopTimes[0].pop(); });
  assert.throws(() => expandResealed(shortStopRow), /EXTERNAL_STOP_TIMES_ROW_SHAPE/u);
});

test("정차 시각 출처(timeSource)는 있는 행만 그대로 실려 펼칠 때 복원되고, 없는 행에는 키가 생기지 않는다(#910 F4)", () => {
  const marked = STOPS.map((row) => (row.tripId === "t-1" && row.stopSequence === 1 ? { ...row, timeSource: "SINGLE_PROVIDER_TIME_DEPARTURE" } : row));
  const artifact = build({ stopTimes: marked });
  const pack = expandExternalStopTimes(written(artifact).fixture, { readBytes: () => artifact.bytes }).packs[0];
  const rows = byId(pack.transitStopTimes, stopKey);
  assert.equal(rows.get("t-1:1").timeSource, "SINGLE_PROVIDER_TIME_DEPARTURE");
  assert.equal(Object.hasOwn(rows.get("t-1:2"), "timeSource"), false);
  assert.deepEqual(rows, byId(marked, stopKey));
  assert.throws(() => build({ stopTimes: STOPS.map((row) => ({ ...row, timeSource: "" })) }), /STOP_TIME_SHAPE/u);
});

test("대상 원천이어도 명시한 snapshot의 trip·stop_time은 팩에 남긴다(#913 광주 보관본: 열차 번호 등 다른 trip 형태)", () => {
  const keptHeader = { ...HEADER, sourceSnapshotId: "official-source-retained" };
  const kept = { ...trip("k-1", keptHeader), trainNo: "1001" };
  const keptStops = [{ ...stop("k-1", 1, "s-a"), ...keptHeader, providerRecordHash: "k-1-1" }, { ...stop("k-1", 2, "s-b"), ...keptHeader, providerRecordHash: "k-1-2" }];
  assert.throws(() => build({ trips: [...TRIPS, kept], stopTimes: [...STOPS, ...keptStops] }), /EXTERNAL_STOP_TIMES_TRIP_SHAPE: k-1/u);
  const artifact = build({ trips: [...TRIPS, kept], stopTimes: [...STOPS, ...keptStops], inlineSourceSnapshotIds: ["official-source-retained"] });
  assert.deepEqual(artifact.inlineTrips.map(({ id }) => id).sort(), ["inline-1", "k-1"]);
  assert.deepEqual(artifact.inlineStopTimes.filter(({ tripId }) => tripId === "k-1").length, 2);
  const { fixture, readBytes } = written(artifact);
  const expanded = expandExternalStopTimes(fixture, { readBytes });
  assert.equal(expanded.packs[0].transitTrips.filter(({ id }) => id === "k-1").length, 1);
  // 남긴 snapshot에 속하지 않은 대상 원천 stop_time은 여전히 고아로 실패한다.
  assert.throws(() => build({ trips: [...TRIPS, kept], stopTimes: [...STOPS, ...keptStops, { ...stop("missing", 1, "s-a"), ...HEADER }], inlineSourceSnapshotIds: ["official-source-retained"] }),
    /ORPHAN_STOP_TIME/u);
});
