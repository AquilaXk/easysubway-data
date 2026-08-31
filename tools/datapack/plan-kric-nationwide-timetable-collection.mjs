import { codepointCompare } from "../lib/codepoint-compare.mjs";

const CANDIDATE_ID = "kric-subway-timetable-exp";
const OPERATION = "subwayTimetableExp";
const ENDPOINT = "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetableExp";
const TARGET_VERSION = "2026-07-13";
const DAY_CDS = Object.freeze(["8", "7", "9"]);
const REQUIRED_FIELDS = Object.freeze(["service_calendar", "trip", "stop_time"]);
const TARGET_OPERATOR_IDS = Object.freeze(["korail", "seoul-metro", "incheon-transit"]);
const EXPECTED_SCOPES = Object.freeze([
  scope("korail", "line-051552e50435", "KR", "WS"),
  scope("korail", "line-41a8c75ec9d8", "KR", "3"),
  scope("korail", "line-472a81add377", "KR", "1"),
  scope("korail", "line-54a7b980b7c3", "KR", "K2"),
  scope("korail", "line-558d0bd8312d", "KR", "K1"),
  scope("korail", "line-6e39be0cb6e2", "KR", "K4"),
  scope("korail", "line-e4939a4b4713", "KR", "K5"),
  scope("korail", "seoul-4", "KR", "4"),
  scope("seoul-metro", "line-15b3b8a93259", "S1", "7"),
  scope("seoul-metro", "line-2b2d9eaa53d0", "S1", "8"),
  scope("seoul-metro", "line-3f41718e0833", "S1", "6"),
  scope("seoul-metro", "line-41a8c75ec9d8", "S1", "3"),
  scope("seoul-metro", "line-472a81add377", "S1", "1"),
  scope("seoul-metro", "line-80fc4d5350d4", "S1", "5"),
  scope("seoul-metro", "seoul-2", "S1", "2"),
  scope("seoul-metro", "seoul-4", "S1", "4"),
  scope("incheon-transit", "line-15b3b8a93259", "IC", "7"),
]);

export function planKricNationwideTimetableCollection({ tally, rosterArtifact, sourceCandidates } = {}) {
  validateTally(tally);
  const candidate = validateCandidate(sourceCandidates);
  const { providerScopes, knownProviderKeys } = validateProviderScopes(rosterArtifact);
  const selectedStations = selectOwnedStations(rosterArtifact, providerScopes, knownProviderKeys);
  const requests = selectedStations.flatMap((station) => DAY_CDS.map((dayCd) => requestFor(station, dayCd)));
  requests.sort((left, right) => codepointCompare(left.requestKey, right.requestKey));
  if (new Set(requests.map(({ requestKey }) => requestKey)).size !== requests.length) {
    throw new Error("duplicate timetable request");
  }
  return {
    schemaVersion: 1,
    artifactKind: "kric-nationwide-timetable-collection-plan",
    planOnly: true,
    targetVersion: TARGET_VERSION,
    sourceId: candidate.id,
    operation: OPERATION,
    endpoint: ENDPOINT,
    credentialEnv: "KRIC_SERVICE_KEY",
    credentialRedacted: true,
    dayCds: [...DAY_CDS],
    providerScopeCount: providerScopes.length,
    stationCount: selectedStations.length,
    requestCount: requests.length,
    requests,
  };
}

function validateTally(tally) {
  if (tally?.targetVersion !== TARGET_VERSION || !Array.isArray(tally?.launchRequired?.requirements)) {
    throw new Error("timetable tally identity is invalid");
  }
  const selected = tally.launchRequired.requirements.filter((entry) => (
    entry?.regionId === "capital"
    && TARGET_OPERATOR_IDS.includes(entry.operatorId)
    && entry.sourceDomain === "schedule_timetable"
  ));
  const expectedByKey = new Map(EXPECTED_SCOPES.map((value) => [scopeKey(value), value]));
  const seen = new Set();
  for (const entry of selected) {
    const key = scopeKey(entry);
    if (seen.has(key)) throw new Error(`duplicate timetable requirement: ${key}`);
    seen.add(key);
    if (!expectedByKey.has(key)) throw new Error(`unknown timetable requirement: ${key}`);
    if (entry.status !== "MISSING" || entry.missingKind !== "NO_ADMITTED_SOURCE" || entry.requiredFieldCount !== 3
      || !sameStrings(entry.unadmittedFields, REQUIRED_FIELDS)) {
      throw new Error(`timetable requirement is not current missing: ${key}`);
    }
  }
  if (seen.size !== EXPECTED_SCOPES.length || [...expectedByKey.keys()].some((key) => !seen.has(key))) {
    throw new Error(`exact ${EXPECTED_SCOPES.length} timetable requirements are required`);
  }
}

function validateCandidate(sourceCandidates) {
  if (sourceCandidates?.schemaVersion !== 1 || sourceCandidates.artifactKind !== "production-source-candidates"
    || !Array.isArray(sourceCandidates.candidates)) {
    throw new Error("source candidates identity is invalid");
  }
  const matches = sourceCandidates.candidates.filter((candidate) => candidate?.id === CANDIDATE_ID);
  if (matches.length !== 1) throw new Error("exactly one timetable candidate is required");
  const [candidate] = matches;
  const operation = candidate?.operation;
  const requiredParameters = ["serviceKey", "format", "railOprIsttCd", "dayCd", "lnCd", "stinCd"];
  if (candidate?.domain !== "schedule_timetable" || operation?.method !== "GET" || operation.endpoint !== ENDPOINT
    || operation.auth?.env !== "KRIC_SERVICE_KEY" || operation.auth?.placement !== "query" || operation.auth?.parameter !== "serviceKey"
    || !sameStrings(operation.requiredParameters, requiredParameters)
    || operation.responseEnvelope !== "{header:{resultCode,resultMsg},body:row[]}"
    || operation.secretPolicy !== "env-only-redacted-output") {
    throw new Error("candidate operation contract is invalid");
  }
  return candidate;
}

function validateProviderScopes(rosterArtifact) {
  if (rosterArtifact?.schemaVersion !== 1 || rosterArtifact.artifactKind !== "kric-nationwide-route-rosters"
    || rosterArtifact.sourceId !== "kric-subway-route-info" || rosterArtifact.targetVersion !== TARGET_VERSION
    || rosterArtifact.credentialRedacted !== true || !Array.isArray(rosterArtifact.providerScopes) || !Array.isArray(rosterArtifact.rosters)) {
    throw new Error("timetable roster identity is invalid");
  }
  const actual = new Map();
  const knownProviderKeys = new Set();
  const expectedByKey = new Map(EXPECTED_SCOPES.map((expected) => [scopeKey(expected), expected]));
  for (const value of rosterArtifact.providerScopes) {
    const targetOwned = value?.regionId === "capital" && TARGET_OPERATOR_IDS.includes(value?.operatorId);
    if (targetOwned) {
      for (const field of ["regionId", "operatorId", "lineId", "mreaWideCd", "railOprIsttCd", "lnCd"]) {
        if (!nonBlank(value[field])) throw new Error(`invalid target-owned provider scope: ${field}`);
      }
      const key = scopeKey(value);
      if (!expectedByKey.has(key)) throw new Error(`unknown target-owned provider scope: ${key}`);
      if (actual.has(key)) throw new Error(`duplicate timetable provider scope: ${key}`);
      actual.set(key, value);
      knownProviderKeys.add(providerKey(value));
      continue;
    }
    if (!nonBlank(value?.mreaWideCd) || !nonBlank(value?.railOprIsttCd) || !nonBlank(value?.lnCd)) continue;
    knownProviderKeys.add(providerKey(value));
  }
  if (actual.size !== EXPECTED_SCOPES.length) {
    throw new Error(`exact ${EXPECTED_SCOPES.length} timetable provider scopes are required`);
  }
  for (const expected of EXPECTED_SCOPES) {
    const value = actual.get(scopeKey(expected));
    if (!value || value.mreaWideCd !== expected.mreaWideCd || value.lnCd !== expected.lnCd || value.railOprIsttCd !== expected.railOprIsttCd) {
      throw new Error(`timetable provider scope mismatch: ${scopeKey(expected)}`);
    }
  }
  return { providerScopes: EXPECTED_SCOPES.map((expected) => actual.get(scopeKey(expected))), knownProviderKeys };
}

function selectOwnedStations(rosterArtifact, providerScopes, knownProviderKeys) {
  const selectedScopeByProvider = new Map(providerScopes.map((providerScope) => [providerKey(providerScope), providerScope]));
  const selectedRosterKeys = new Set(providerScopes.map((providerScope) => `${providerScope.mreaWideCd}:${providerScope.lnCd}`));
  const rostersByRequest = new Map();
  for (const roster of rosterArtifact.rosters) {
    if (!nonBlank(roster?.mreaWideCd) || !nonBlank(roster?.lnCd)) continue;
    const key = `${roster.mreaWideCd}:${roster.lnCd}`;
    if (!selectedRosterKeys.has(key)) continue;
    if (rostersByRequest.has(key)) throw new Error(`duplicate timetable roster: ${key}`);
    if (roster?.schemaVersion !== 1 || roster.artifactKind !== "kric-route-roster" || roster.sourceId !== "kric-subway-route-info"
      || roster.resultCode !== "00" || !Array.isArray(roster.stations)) {
      throw new Error(`invalid timetable roster: ${key}`);
    }
    rostersByRequest.set(key, roster);
  }
  const selected = [];
  const stationKeys = new Set();
  for (const providerScope of providerScopes) {
    const rosterKey = `${providerScope.mreaWideCd}:${providerScope.lnCd}`;
    const roster = rostersByRequest.get(rosterKey);
    if (!roster) throw new Error(`selected timetable roster is missing: ${rosterKey}`);
    let found = false;
    for (const station of roster.stations) {
      if (station?.mreaWideCd !== providerScope.mreaWideCd || station.lnCd !== providerScope.lnCd
        || !nonBlank(station.railOprIsttCd) || !nonBlank(station.stinCd)) {
        throw new Error(`invalid timetable roster station: ${rosterKey}`);
      }
      const providerStationKey = `${station.mreaWideCd}:${station.railOprIsttCd}:${station.lnCd}`;
      if (!knownProviderKeys.has(providerStationKey)) throw new Error(`unknown provider operator: ${station.railOprIsttCd}/${station.lnCd}`);
      const ownerScope = selectedScopeByProvider.get(providerStationKey);
      if (ownerScope !== providerScope) continue;
      found = true;
      const stationKey = `${scopeKey(providerScope)}:${station.stinCd}`;
      if (stationKeys.has(stationKey)) throw new Error(`duplicate selected provider station: ${stationKey}`);
      stationKeys.add(stationKey);
      selected.push({ ...providerScope, stinCd: station.stinCd });
    }
    if (!found) throw new Error(`selected provider station is missing: ${scopeKey(providerScope)}`);
  }
  return selected.sort((left, right) => codepointCompare(stationKeyFor(left), stationKeyFor(right)));
}

function requestFor(station, dayCd) {
  const params = { format: "json", railOprIsttCd: station.railOprIsttCd, lnCd: station.lnCd, stinCd: station.stinCd, dayCd };
  return {
    operation: OPERATION,
    endpoint: ENDPOINT,
    requestKey: `${OPERATION}|${params.railOprIsttCd}|${params.lnCd}|${params.stinCd}|${params.dayCd}`,
    params,
  };
}

function scope(operatorId, lineId, railOprIsttCd, lnCd) {
  return { regionId: "capital", operatorId, lineId, mreaWideCd: "01", railOprIsttCd, lnCd };
}

function scopeKey({ regionId, operatorId, lineId } = {}) {
  return `${requiredText(regionId, "scope.regionId")}:${requiredText(operatorId, "scope.operatorId")}:${requiredText(lineId, "scope.lineId")}`;
}

function providerKey({ mreaWideCd, railOprIsttCd, lnCd }) {
  return `${mreaWideCd}:${railOprIsttCd}:${lnCd}`;
}

function stationKeyFor({ regionId, operatorId, lineId, stinCd }) {
  return `${regionId}:${operatorId}:${lineId}:${stinCd}`;
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function nonBlank(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sameStrings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
