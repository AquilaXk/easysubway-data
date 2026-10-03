import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { kricStationLinesOfficialTimetable } from "./kric-station-lines-timetable.mjs";
import { canonicalJson } from "./manifest-validation.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const BINDINGS = [{ lnCd: "B1", lineId: "line-light", stationAliases: { "가역(부역)": "가역" }, aliasEvidence: { "가역(부역)": "부역명 괄호 표기" } }];
const trip = (trainNumber, dayCd, kind) => ({
  lineId: "line-light", providerTripKey: `B1|${trainNumber}|${dayCd}|ASC`, serviceDayKind: kind, servicePattern: "LOCAL", headsign: "나역",
  sourceRowSha256: sha(trainNumber + dayCd), stops: [{ stationName: "가역(부역)", arrivalSeconds: null, departureSeconds: 21600 }, { stationName: "나역", arrivalSeconds: 21780, departureSeconds: null }],
  provenance: { lnCd: "B1", trainNumber, dayCd, direction: "ASC" },
});

function snapshotAndEvidence() {
  const trips = [trip("1001", "8", "WEEKDAY"), trip("3001", "9", "SATURDAY_SUNDAY_HOLIDAY")];
  const content = { schemaVersion: 1, artifactKind: "kric-station-timetable-snapshot", sourceId: "kric-subway-timetable-station-lines",
    catalogProviderId: "provider:kric-subway-timetable", capturedAt: "2026-10-03T00:30:00.000Z", collectedAt: "2026-10-03T00:31:00.000Z",
    raw: { rawSha256: "a".repeat(64), byteSize: 1, rawObjectUri: "oci://x", publicationReceiptSha256: "b".repeat(64) },
    serviceDayPolicy: "policy", lines: [], trips, quarantine: [] };
  const contentSha256 = sha(canonicalJson(content));
  const snapshot = { ...content, snapshotId: "kric-subway-timetable-station-lines-20261003", contentSha256 };
  const evidence = { snapshotId: snapshot.snapshotId, contentSha256, rawSha256: "a".repeat(64), tripsSha256: sha(JSON.stringify(trips)), tripCount: 2 };
  return { snapshot, evidence };
}

test("파생 스냅샷을 공용 적재기 입력으로 바꾼다: 노선 키는 KRIC 선코드, 휴일은 WEEKEND_HOLIDAY, alias는 근거와 함께", () => {
  const { snapshot, evidence } = snapshotAndEvidence();
  const { provider, lineBindings } = kricStationLinesOfficialTimetable(snapshot, evidence, { bindings: BINDINGS });
  assert.equal(provider.sourceId, "kric-subway-timetable-station-lines");
  assert.equal(provider.sourceSnapshotId, snapshot.snapshotId);
  assert.equal(provider.observedAt, "2026-10-03T00:31:00.000Z");
  assert.deepEqual(provider.trips.map(({ routeKey, trainNumber, serviceDayKind, sourceDayKey }) => [routeKey, trainNumber, serviceDayKind, sourceDayKey]),
    [["B1", "1001", "WEEKDAY", "8"], ["B1", "3001", "WEEKEND_HOLIDAY", "9"]]);
  assert.deepEqual(lineBindings, [{ lineId: "line-light", routeKey: "B1", routeName: "부산김해경전철", stationAliases: { "가역(부역)": { nameKo: "가역", reason: "부역명 괄호 표기" } } }]);
});

test("스냅샷 내용이 바뀌었거나 inventory evidence와 다르면 실패한다", () => {
  const { snapshot, evidence } = snapshotAndEvidence();
  const tampered = structuredClone(snapshot);
  tampered.trips[0].stops[1].arrivalSeconds += 60;
  assert.throws(() => kricStationLinesOfficialTimetable(tampered, evidence, { bindings: BINDINGS }), /KRIC_STATION_LINES_TIMETABLE_SNAPSHOT/u);
  for (const change of [{ snapshotId: "other" }, { contentSha256: "0".repeat(64) }, { rawSha256: "0".repeat(64) }, { tripsSha256: "0".repeat(64) }, { tripCount: 3 }]) {
    assert.throws(() => kricStationLinesOfficialTimetable(snapshot, { ...evidence, ...change }, { bindings: BINDINGS }), /KRIC_STATION_LINES_TIMETABLE_EVIDENCE/u);
  }
});
