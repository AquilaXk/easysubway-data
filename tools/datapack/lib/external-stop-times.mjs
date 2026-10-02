import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { codepointCompare } from "../../lib/codepoint-compare.mjs";

// #899: 공식 원천 시간표(trip·stop_time)를 커밋된 전국 팩 JSON 밖의 결정적 gzip 파일로 둔다.
// 팩 JSON이 GitHub 파일 한도(100MB) 안에서 여유를 갖게 하고, 원천 단위로 같은 provenance를 행마다 복제하지 않는다.
//
// 파일(gzip 전 JSON): { schemaVersion: 2, artifactKind, tripColumns, stopTimeColumns,
//   sections: [{ header: { sourceId, sourceSnapshotId, evidenceHash, provenanceKind, derivationKind, updatedAt },
//                stopTimeProvenance: "TRIP_INHERITED" | "ROW_COPY", trips: [[...]], stopTimes: [[...]] }] }
// - trip은 헤더(원천 공통 provenance)와 trip별 providerRecordHash로 원래 객체를 그대로 복원한다.
// - TRIP_INHERITED: stop_time 행에 provenance가 없고 tripId FK로 trip provenance를 이어받는다.
// - ROW_COPY: stop_time 행 provenance가 소속 trip과 같았다. 펼칠 때 같은 값을 다시 붙인다.
// 팩 결속: pack.externalTransitStopTimes = { path, sha256, tripCount, stopTimeCount,
//   sections: [{ sourceId, sourceSnapshotId, stopTimeProvenance, tripCount, stopTimeCount, byLine: { lineId: { tripCount, stopTimeCount } } }] }
// 읽는 쪽(build-datapack·후보 accessibility 입력·anti-cheat guard)은 expandExternalStopTimes로 펼친다.
// 바이트 sha·결속 요약·trip FK·provenance·고아 trip·중복 중 하나라도 어긋나면 실패한다.

export const OFFICIAL_STOP_TIMES_PATH = "tools/datapack/release/nationwide-official-stop-times.json.gz";
export const EXTERNAL_STOP_TIMES_KEY = "externalTransitStopTimes";
const ARTIFACT_KIND = "datapack-official-timetable";
const HEADER_FIELDS = Object.freeze(["sourceId", "sourceSnapshotId", "evidenceHash", "provenanceKind", "derivationKind", "updatedAt"]);
const TRIP_COLUMNS = Object.freeze(["id", "routeId", "serviceId", "tripHeadsign", "directionId", "servicePattern", "serviceClass", "serviceDayStartSeconds", "providerRecordHash"]);
const STOP_TIME_COLUMNS = Object.freeze(["tripId", "stopSequence", "stationId", "lineId", "arrivalSeconds", "departureSeconds", "pickupType", "dropOffType"]);
const ROW_PROVENANCE_FIELDS = Object.freeze([...HEADER_FIELDS, "providerRecordHash"]);
const STOP_TIME_PROVENANCE = Object.freeze({ TRIP_INHERITED: "TRIP_INHERITED", ROW_COPY: "ROW_COPY" });
const GZIP_LEVEL = 9;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, detail = "") => { throw new Error(`EXTERNAL_STOP_TIMES_${code}${detail ? `: ${detail}` : ""}`); };
const sameKeys = (object, keys) => Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));

/**
 * 팩에서 지정한 원천의 trip·stop_time을 떼어 결정적 gzip 바이트와 결속을 만든다. 같은 입력이면 같은 바이트다.
 * @returns {{ bytes: Buffer, binding: object, inlineTrips: object[], inlineStopTimes: object[] }}
 */
export function buildExternalStopTimesArtifact({ trips, stopTimes, sourceIds }) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0 || new Set(sourceIds).size !== sourceIds.length) fail("SOURCE_IDS");
  const external = new Set(sourceIds);
  const sectionsByKey = new Map();
  const tripSection = new Map();
  const inlineTrips = [];
  for (const trip of trips) {
    if (!external.has(trip.sourceId)) { inlineTrips.push(trip); continue; }
    const key = `${trip.sourceId}\u0000${trip.sourceSnapshotId}`;
    if (!sectionsByKey.has(key)) sectionsByKey.set(key, { header: tripHeader(trip), trips: [], stopTimes: [], rowProvenance: new Set() });
    const section = sectionsByKey.get(key);
    assertTripShape(trip, section.header);
    if (tripSection.has(trip.id)) fail("TRIP_DUPLICATE", trip.id);
    tripSection.set(trip.id, { section, trip });
    section.trips.push(trip);
  }
  for (const sourceId of sourceIds) {
    if (![...sectionsByKey.values()].some(({ header }) => header.sourceId === sourceId)) fail("SOURCE_HAS_NO_TRIPS", sourceId);
  }
  const inlineStopTimes = [];
  for (const row of stopTimes) {
    const owner = tripSection.get(row.tripId);
    if (!owner) {
      if (external.has(row.sourceId)) fail("ORPHAN_STOP_TIME", row.tripId);
      inlineStopTimes.push(row);
      continue;
    }
    owner.section.rowProvenance.add(stopTimeProvenanceKind(row, owner.trip));
    owner.section.stopTimes.push(row);
  }
  const sections = [...sectionsByKey.values()]
    .sort((left, right) => codepointCompare(left.header.sourceId, right.header.sourceId)
      || codepointCompare(left.header.sourceSnapshotId, right.header.sourceSnapshotId))
    .map((section) => {
      if (section.rowProvenance.size !== 1) fail("STOP_TIME_PROVENANCE_MIXED", section.header.sourceId);
      const withStops = new Set(section.stopTimes.map(({ tripId }) => tripId));
      for (const { id } of section.trips) if (!withStops.has(id)) fail("TRIP_WITHOUT_STOP_TIMES", id);
      return {
        header: section.header,
        stopTimeProvenance: [...section.rowProvenance][0],
        trips: [...section.trips].sort((left, right) => codepointCompare(left.id, right.id)).map((trip) => TRIP_COLUMNS.map((column) => trip[column])),
        stopTimes: [...section.stopTimes]
          .sort((left, right) => codepointCompare(left.tripId, right.tripId) || left.stopSequence - right.stopSequence)
          .map((row) => STOP_TIME_COLUMNS.map((column) => row[column])),
      };
    });
  const content = {
    schemaVersion: 2,
    artifactKind: ARTIFACT_KIND,
    tripColumns: [...TRIP_COLUMNS],
    stopTimeColumns: [...STOP_TIME_COLUMNS],
    sections,
  };
  const bytes = gzipSync(Buffer.from(`${JSON.stringify(content)}\n`), { level: GZIP_LEVEL });
  return { bytes, binding: bindingFor(content, bytes), inlineTrips, inlineStopTimes };
}

function tripHeader(trip) {
  const header = Object.fromEntries(HEADER_FIELDS.map((field) => [field, trip[field]]));
  if (HEADER_FIELDS.some((field) => typeof header[field] !== "string" || header[field].length === 0)) fail("TRIP_PROVENANCE_MISSING", trip.id);
  return header;
}

function assertTripShape(trip, header) {
  if (!sameKeys(trip, [...TRIP_COLUMNS, ...HEADER_FIELDS.filter((field) => !TRIP_COLUMNS.includes(field))])) fail("TRIP_SHAPE", trip.id);
  if (typeof trip.providerRecordHash !== "string" || trip.providerRecordHash.length === 0) fail("TRIP_PROVENANCE_MISSING", trip.id);
  for (const field of HEADER_FIELDS) if (trip[field] !== header[field]) fail("TRIP_HEADER_MISMATCH", `${trip.id} ${field}`);
}

function stopTimeProvenanceKind(row, trip) {
  if (sameKeys(row, STOP_TIME_COLUMNS)) return STOP_TIME_PROVENANCE.TRIP_INHERITED;
  if (sameKeys(row, [...STOP_TIME_COLUMNS, ...ROW_PROVENANCE_FIELDS])
    && ROW_PROVENANCE_FIELDS.every((field) => row[field] === trip[field])) return STOP_TIME_PROVENANCE.ROW_COPY;
  fail("STOP_TIME_SHAPE", `${row.tripId}:${row.stopSequence}`);
}

function bindingFor(content, bytes) {
  const sections = content.sections.map((section) => {
    const byLine = {};
    for (const values of section.stopTimes) {
      const lineId = values[3];
      const line = byLine[lineId] ?? { tripIds: new Set(), stopTimeCount: 0 };
      line.tripIds.add(values[0]);
      line.stopTimeCount += 1;
      byLine[lineId] = line;
    }
    return {
      sourceId: section.header.sourceId,
      sourceSnapshotId: section.header.sourceSnapshotId,
      stopTimeProvenance: section.stopTimeProvenance,
      tripCount: section.trips.length,
      stopTimeCount: section.stopTimes.length,
      byLine: Object.fromEntries(Object.entries(byLine).sort(([left], [right]) => codepointCompare(left, right))
        .map(([lineId, { tripIds, stopTimeCount }]) => [lineId, { tripCount: tripIds.size, stopTimeCount }])),
    };
  });
  return {
    path: OFFICIAL_STOP_TIMES_PATH,
    sha256: sha256(bytes),
    tripCount: sections.reduce((total, { tripCount }) => total + tripCount, 0),
    stopTimeCount: sections.reduce((total, { stopTimeCount }) => total + stopTimeCount, 0),
    sections,
  };
}

/**
 * 팩이 결속한 외부 시간표를 펼쳐 transitTrips·transitStopTimes에 더하고 결속 키를 지운 fixture를 돌려준다.
 * 결속이 없는 팩은 그대로 둔다.
 */
export function expandExternalStopTimes(fixture, { repositoryRoot, readBytes = (relative) => readFileSync(path.join(repositoryRoot, relative)) } = {}) {
  if (!Array.isArray(fixture?.packs)) return fixture;
  let changed = false;
  const packs = fixture.packs.map((pack) => {
    const binding = pack?.[EXTERNAL_STOP_TIMES_KEY];
    if (binding === undefined) return pack;
    changed = true;
    const { trips, stopTimes } = readBoundTimetable(binding, pack, readBytes);
    const expanded = {
      ...pack,
      transitTrips: [...(pack.transitTrips ?? []), ...trips],
      transitStopTimes: [...(pack.transitStopTimes ?? []), ...stopTimes],
    };
    delete expanded[EXTERNAL_STOP_TIMES_KEY];
    return expanded;
  });
  return changed ? { ...fixture, packs } : fixture;
}

function readBoundTimetable(binding, pack, readBytes) {
  if (binding?.path !== OFFICIAL_STOP_TIMES_PATH || !/^[a-f0-9]{64}$/u.test(binding.sha256 ?? "")) fail("BINDING");
  const bytes = readBytes(binding.path);
  if (sha256(bytes) !== binding.sha256) fail("SHA256_MISMATCH", binding.path);
  let content;
  try { content = JSON.parse(gunzipSync(bytes).toString("utf8")); } catch { fail("CONTENT", binding.path); }
  if (content?.schemaVersion !== 2 || content.artifactKind !== ARTIFACT_KIND
    || JSON.stringify(content.tripColumns) !== JSON.stringify(TRIP_COLUMNS)
    || JSON.stringify(content.stopTimeColumns) !== JSON.stringify(STOP_TIME_COLUMNS) || !Array.isArray(content.sections)) {
    fail("CONTENT", binding.path);
  }
  if (JSON.stringify(bindingFor(content, bytes)) !== JSON.stringify(binding)) fail("BINDING_MISMATCH", binding.path);
  const inlineTripIds = new Set((pack.transitTrips ?? []).map(({ id }) => id));
  const stopKeys = new Set((pack.transitStopTimes ?? []).map(({ tripId, stopSequence }) => `${tripId}\u0000${stopSequence}`));
  const trips = [];
  const stopTimes = [];
  for (const section of content.sections) {
    if (!sameKeys(section.header ?? {}, HEADER_FIELDS) || HEADER_FIELDS.some((field) => typeof section.header[field] !== "string" || section.header[field].length === 0)
      || !Object.values(STOP_TIME_PROVENANCE).includes(section.stopTimeProvenance)) fail("SECTION", section.header?.sourceId);
    const sectionTrips = new Map();
    for (const values of section.trips) {
      const trip = { ...Object.fromEntries(TRIP_COLUMNS.map((column, index) => [column, values[index]])), ...section.header };
      if (typeof trip.providerRecordHash !== "string" || trip.providerRecordHash.length === 0) fail("TRIP_PROVENANCE_MISSING", trip.id);
      if (inlineTripIds.has(trip.id) || sectionTrips.has(trip.id)) fail("TRIP_DUPLICATE", trip.id);
      inlineTripIds.add(trip.id);
      sectionTrips.set(trip.id, trip);
      trips.push(trip);
    }
    const withStops = new Set();
    for (const values of section.stopTimes) {
      const row = Object.fromEntries(STOP_TIME_COLUMNS.map((column, index) => [column, values[index]]));
      const trip = sectionTrips.get(row.tripId);
      if (!trip) fail("ORPHAN_STOP_TIME", row.tripId);
      const key = `${row.tripId}\u0000${row.stopSequence}`;
      if (stopKeys.has(key)) fail("DUPLICATE_STOP_TIME", key);
      stopKeys.add(key);
      withStops.add(row.tripId);
      stopTimes.push(section.stopTimeProvenance === STOP_TIME_PROVENANCE.ROW_COPY
        ? { ...row, ...Object.fromEntries(ROW_PROVENANCE_FIELDS.map((field) => [field, trip[field]])) }
        : row);
    }
    for (const id of sectionTrips.keys()) if (!withStops.has(id)) fail("TRIP_WITHOUT_STOP_TIMES", id);
  }
  return { trips, stopTimes };
}
