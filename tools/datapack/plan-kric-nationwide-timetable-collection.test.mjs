import assert from "node:assert/strict";
import test from "node:test";

import { planKricNationwideTimetableCollection } from "./plan-kric-nationwide-timetable-collection.mjs";

const KORAIL_LINES = [
  ["line-051552e50435", "WS"], ["line-41a8c75ec9d8", "3"], ["line-472a81add377", "1"], ["line-54a7b980b7c3", "K2"],
  ["line-558d0bd8312d", "K1"], ["line-6e39be0cb6e2", "K4"], ["line-e4939a4b4713", "K5"], ["seoul-4", "4"],
];
const SEOUL_LINES = [
  ["line-15b3b8a93259", "7"], ["line-2b2d9eaa53d0", "8"], ["line-3f41718e0833", "6"], ["line-41a8c75ec9d8", "3"],
  ["line-472a81add377", "1"], ["line-80fc4d5350d4", "5"], ["seoul-2", "2"], ["seoul-4", "4"],
];
const INCHEON_LINES = [["line-15b3b8a93259", "7"]];
const ADMITTED_INCHEON_LINES = [
  ["line-42b5805f3b5a", "2"], ["line-98718184f016", "1"],
];

function inputs() {
  const missingProviderScopes = [
    ...KORAIL_LINES.map(([lineId, lnCd]) => scope("korail", lineId, "KR", lnCd)),
    ...SEOUL_LINES.map(([lineId, lnCd]) => scope("seoul-metro", lineId, "S1", lnCd)),
    ...INCHEON_LINES.map(([lineId, lnCd]) => scope("incheon-transit", lineId, "IC", lnCd)),
  ];
  const admittedProviderScopes = ADMITTED_INCHEON_LINES.map(([lineId, lnCd]) => scope("incheon-transit", lineId, "IC", lnCd));
  const providerScopes = [...missingProviderScopes, ...admittedProviderScopes];
  return {
    tally: {
      targetVersion: "2026-07-13",
      launchRequired: { requirements: [
        ...missingProviderScopes.map(missingRequirement),
        ...admittedProviderScopes.map(admittedRequirement),
      ] },
    },
    rosterArtifact: {
      schemaVersion: 1, artifactKind: "kric-nationwide-route-rosters", sourceId: "kric-subway-route-info", targetVersion: "2026-07-13",
      credentialRedacted: true, providerScopes,
      rosters: rostersFor(providerScopes),
    },
    sourceCandidates: { schemaVersion: 1, artifactKind: "production-source-candidates", candidates: [candidate()] },
  };
}

test("#459 plans the exact roster-owned IC/7 station and service-day requests", () => {
  const input = inputs();
  input.rosterArtifact.providerScopes.push(scope("other", "other-line", "OT", "WS"));
  input.rosterArtifact.rosters[0].stations.push({ mreaWideCd: "01", railOprIsttCd: "OT", lnCd: "WS", stinCd: "non-target" });
  input.rosterArtifact.rosters.push({ malformed: true }, { mreaWideCd: "99", lnCd: "other", stations: [] }, { mreaWideCd: "99", lnCd: "other", stations: [] });
  const result = planKricNationwideTimetableCollection(input);
  assert.equal(result.planOnly, true);
  assert.equal(result.credentialEnv, "KRIC_SERVICE_KEY");
  assert.equal(result.credentialRedacted, true);
  assert.equal(result.operation, "subwayTimetableExp");
  assert.deepEqual(result.dayCds, ["8", "7", "9"]);
  assert.equal(result.providerScopeCount, 17);
  assert.equal(result.stationCount, 27);
  assert.equal(result.requestCount, 81);
  assert.ok(result.requests.every(({ params }) => !Object.hasOwn(params, "serviceKey") && params.format === "json"));
  assert.ok(result.requests.every(({ endpoint }) => endpoint === "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetableExp"));
  assert.deepEqual(result.requests.map(({ requestKey }) => requestKey), [...result.requests.map(({ requestKey }) => requestKey)].sort());
  assert.equal(new Set(result.requests.map(({ requestKey }) => requestKey)).size, 81);
  const incheonRequests = result.requests.filter(({ params }) => params.railOprIsttCd === "IC" && params.lnCd === "7");
  assert.equal(incheonRequests.length, 33);
  assert.deepEqual(
    [...new Set(incheonRequests.map(({ params }) => params.stinCd))].sort(),
    Array.from({ length: 11 }, (_, index) => String(751 + index)),
  );
  assert.deepEqual([...new Set(incheonRequests.map(({ params }) => params.dayCd))].sort(), ["7", "8", "9"]);
  assert.ok(!JSON.stringify(result).includes("serviceKey="));
});

test("#454 planner는 selector/candidate/roster identity와 selected provider station 불일치를 fail closed 한다", () => {
  const duplicate = inputs();
  duplicate.tally.launchRequired.requirements.push(duplicate.tally.launchRequired.requirements[0]);
  assert.throws(() => planKricNationwideTimetableCollection(duplicate), /duplicate timetable requirement/);

  const unknown = inputs();
  unknown.rosterArtifact.rosters[0].stations.push({ mreaWideCd: "01", railOprIsttCd: "XX", lnCd: "WS", stinCd: "unknown" });
  assert.throws(() => planKricNationwideTimetableCollection(unknown), /unknown provider operator/);

  const missingOwner = inputs();
  missingOwner.rosterArtifact.rosters[0].stations = [{ mreaWideCd: "01", railOprIsttCd: "S1", lnCd: "WS", stinCd: "wrong-owner" }];
  assert.throws(() => planKricNationwideTimetableCollection(missingOwner), /unknown provider operator/);

  const wrongCandidate = inputs();
  wrongCandidate.sourceCandidates.candidates[0].operation.endpoint = "http://example.invalid/subwayTimetableExp";
  assert.throws(() => planKricNationwideTimetableCollection(wrongCandidate), /candidate operation contract is invalid/);

  const duplicateCandidate = inputs();
  duplicateCandidate.sourceCandidates.candidates.push(candidate());
  assert.throws(() => planKricNationwideTimetableCollection(duplicateCandidate), /exactly one timetable candidate/);

  const malformedTargetScope = inputs();
  malformedTargetScope.rosterArtifact.providerScopes.push(scope("korail", "unknown-target", "KR", "X"));
  assert.throws(() => planKricNationwideTimetableCollection(malformedTargetScope), /unknown target-owned provider scope/);

  const unknownIncheonCollision = inputs();
  unknownIncheonCollision.tally.launchRequired.requirements.push(
    missingRequirement(scope("incheon-transit", "unknown-target", "IC", "7")),
  );
  assert.throws(() => planKricNationwideTimetableCollection(unknownIncheonCollision), /unknown timetable requirement/);

  const invalidSelectedRoster = inputs();
  invalidSelectedRoster.rosterArtifact.rosters[0].sourceId = "wrong-source";
  assert.throws(() => planKricNationwideTimetableCollection(invalidSelectedRoster), /invalid timetable roster/);

  const blankSelectedStation = inputs();
  blankSelectedStation.rosterArtifact.rosters[0].stations[0].stinCd = " ";
  assert.throws(() => planKricNationwideTimetableCollection(blankSelectedStation), /invalid timetable roster station/);
});

function scope(operatorId, lineId, railOprIsttCd, lnCd) {
  return { regionId: "capital", operatorId, lineId, mreaWideCd: "01", railOprIsttCd, lnCd };
}

function missingRequirement({ regionId, operatorId, lineId }) {
  return {
    regionId, operatorId, lineId, sourceDomain: "schedule_timetable", status: "MISSING", missingKind: "NO_ADMITTED_SOURCE",
    requiredFieldCount: 3, unadmittedFields: ["service_calendar", "trip", "stop_time"],
  };
}

function admittedRequirement({ regionId, operatorId, lineId }) {
  return {
    regionId, operatorId, lineId, sourceDomain: "schedule_timetable", status: "INVENTORY_ADMITTED", missingKind: null,
    admissionRatio: 1, admittedFieldCount: 3, admittedSourceIds: [`${lineId}-timetable`],
    requiredFieldCount: 3, unadmittedFields: [],
  };
}

function station(providerScope, stinCd) {
  return { railOprIsttCd: providerScope.railOprIsttCd, lnCd: providerScope.lnCd, mreaWideCd: "01", stinCd };
}

function rostersFor(providerScopes) {
  const byRequest = new Map();
  for (const [index, providerScope] of providerScopes.entries()) {
    const key = `${providerScope.mreaWideCd}:${providerScope.lnCd}`;
    const roster = byRequest.get(key) ?? {
      schemaVersion: 1, artifactKind: "kric-route-roster", sourceId: "kric-subway-route-info", resultCode: "00", mreaWideCd: "01", lnCd: providerScope.lnCd, stations: [],
    };
    if (providerScope.operatorId === "incheon-transit") {
      for (let stinCd = 751; stinCd <= 761; stinCd += 1) roster.stations.push(station(providerScope, String(stinCd)));
    } else {
      roster.stations.push(station(providerScope, `station-${String(index).padStart(2, "0")}`));
    }
    byRequest.set(key, roster);
  }
  return [...byRequest.values()];
}

function candidate() {
  return {
    id: "kric-subway-timetable-exp",
    domain: "schedule_timetable",
    operation: {
      method: "GET", endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetableExp",
      auth: { env: "KRIC_SERVICE_KEY", placement: "query", parameter: "serviceKey" },
      requiredParameters: ["serviceKey", "format", "railOprIsttCd", "dayCd", "lnCd", "stinCd"],
      responseEnvelope: "{header:{resultCode,resultMsg},body:row[]}", secretPolicy: "env-only-redacted-output",
    },
  };
}
