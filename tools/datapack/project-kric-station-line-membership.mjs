import { codepointCompare } from "../lib/codepoint-compare.mjs";

const SOURCE_ID = "kric-subway-route-info";
const SOURCE_DOMAIN = "station_line_membership";
const REQUIRED_FIELDS = ["line", "station_name", "station_code"];
const EXPECTED_SCOPES = [
  ["korail", "line-051552e50435", "WS", "KR"],
  ["korail", "line-41a8c75ec9d8", "3", "KR"],
  ["korail", "line-472a81add377", "1", "KR"],
  ["korail", "line-54a7b980b7c3", "K2", "KR"],
  ["korail", "line-558d0bd8312d", "K1", "KR"],
  ["korail", "line-6e39be0cb6e2", "K4", "KR"],
  ["korail", "line-e4939a4b4713", "K5", "KR"],
  ["korail", "seoul-4", "4", "KR"],
  ["operator-c361f9fc17e9", "line-2b2d9eaa53d0", "8", "NU"],
  ["operator-c361f9fc17e9", "seoul-4", "4", "NU"],
  ["seoul-metro", "line-15b3b8a93259", "7", "S1"],
  ["seoul-metro", "line-2b2d9eaa53d0", "8", "S1"],
  ["seoul-metro", "line-3f41718e0833", "6", "S1"],
  ["seoul-metro", "line-41a8c75ec9d8", "3", "S1"],
  ["seoul-metro", "line-472a81add377", "1", "S1"],
  ["seoul-metro", "line-80fc4d5350d4", "5", "S1"],
  ["seoul-metro", "seoul-2", "2", "S1"],
  ["seoul-metro", "seoul-4", "4", "S1"],
].map(([operatorId, lineId, lnCd, railOprIsttCd]) => ({
  regionId: "capital", operatorId, lineId, mreaWideCd: "01", lnCd, railOprIsttCd,
}));
const EXPECTED_BY_SCOPE_KEY = new Map(EXPECTED_SCOPES.map((scope) => [scopeKey(scope), scope]));
const SELECTED_REQUEST_KEYS = new Set(EXPECTED_SCOPES.map(requestKey));
const TARGET_OPERATOR_IDS = new Set(EXPECTED_SCOPES.map(({ operatorId }) => operatorId));

export function projectKricStationLineMembership({ tally, rosterArtifact } = {}) {
  const targetVersion = requiredString(tally?.targetVersion, "tally.targetVersion");
  validateTally(tally, targetVersion);
  validateRosterArtifactIdentity(rosterArtifact, targetVersion);
  const providerScopes = indexProviderScopes(rosterArtifact.providerScopes);
  validateExpectedProviderScopes(providerScopes.byScopeKey);
  const rosterByRequest = validateSelectedRosters(rosterArtifact.rosters, providerScopes.operatorCodesByRequest);
  const records = [];

  for (const scope of [...EXPECTED_SCOPES].sort(compareScope)) {
    const roster = rosterByRequest.get(requestKey(scope));
    if (!roster) throw new Error(`provider roster is missing: ${requestKey(scope)}`);
    const stations = roster.stations.filter(({ railOprIsttCd }) => railOprIsttCd === scope.railOprIsttCd);
    if (stations.length === 0) throw new Error(`provider station rows are missing: ${scopeKey(scope)}`);

    const stationCodes = new Set();
    for (const station of stations.sort((left, right) => codepointCompare(left.stinCd, right.stinCd))) {
      const stationCode = requiredString(station?.stinCd, `station code ${scopeKey(scope)}`);
      const stationName = requiredString(station?.stinNm, `station name ${scopeKey(scope)}`);
      if (stationCodes.has(stationCode)) throw new Error(`duplicate station code: ${scopeKey(scope)}:${stationCode}`);
      stationCodes.add(stationCode);
      records.push({
        regionId: scope.regionId,
        operatorId: scope.operatorId,
        sourceDomain: SOURCE_DOMAIN,
        line: scope.lineId,
        station_name: stationName,
        station_code: stationCode,
        sourceId: SOURCE_ID,
        provider: {
          mreaWideCd: scope.mreaWideCd,
          lnCd: scope.lnCd,
          railOprIsttCd: scope.railOprIsttCd,
        },
      });
    }
  }

  return {
    artifactKind: "kric-station-line-membership-projection",
    projectionOnly: true,
    targetVersion,
    sourceId: SOURCE_ID,
    records,
  };
}

function validateExpectedProviderScopes(byScopeKey) {
  for (const scope of EXPECTED_SCOPES) {
    const observedScope = byScopeKey.get(scopeKey(scope));
    if (!observedScope || !sameScope(observedScope, scope)) {
      throw new Error(`provider scope set does not match: ${scopeKey(scope)}`);
    }
  }
}

function validateTally(tally, targetVersion) {
  if (!Array.isArray(tally?.launchRequired?.requirements)) {
    throw new Error("tally.launchRequired.requirements is required");
  }
  const expectedByKey = new Map(EXPECTED_SCOPES.map((scope) => [scopeKey(scope), scope]));
  const relevant = tally.launchRequired.requirements.filter((requirement) => (
    requirement?.regionId === "capital"
      && requirement.sourceDomain === SOURCE_DOMAIN
      && EXPECTED_SCOPES.some(({ operatorId }) => requirement.operatorId === operatorId)
  ));
  if (relevant.length !== EXPECTED_SCOPES.length) throw new Error("exactly 18 station-line membership requirements are required");
  const observed = new Set();
  for (const requirement of relevant) {
    const key = scopeKey(requirement);
    if (!expectedByKey.has(key) || observed.has(key)) {
      throw new Error(`exactly 18 station-line membership requirements are required: ${key}`);
    }
    observed.add(key);
    if (requirement.status !== "MISSING") throw new Error(`selected requirement must be MISSING: ${key}`);
    if (requirement.requiredFieldCount !== REQUIRED_FIELDS.length
      || !sameSorted(requirement.unadmittedFields, REQUIRED_FIELDS)) {
      throw new Error(`selected requirement fields are invalid: ${key}`);
    }
  }
  if (observed.size !== EXPECTED_SCOPES.length || targetVersion.length === 0) {
    throw new Error("exactly 18 station-line membership requirements are required");
  }
}

function validateRosterArtifactIdentity(rosterArtifact, targetVersion) {
  if (rosterArtifact?.artifactKind !== "kric-nationwide-route-rosters"
    || rosterArtifact.schemaVersion !== 1
    || rosterArtifact.sourceId !== SOURCE_ID
    || rosterArtifact.targetVersion !== targetVersion
    || rosterArtifact.credentialRedacted !== true
    || !Array.isArray(rosterArtifact.providerScopes)
    || !Array.isArray(rosterArtifact.rosters)) {
    throw new Error("KRIC roster artifact identity is invalid");
  }
}

function validateSelectedRosters(rosters, operatorCodesByRequest) {
  const rosterByRequest = new Map();
  for (const roster of rosters) {
    const key = optionalRequestKey(roster);
    if (!key || !SELECTED_REQUEST_KEYS.has(key)) continue;
    if (roster?.artifactKind !== "kric-route-roster"
      || roster.schemaVersion !== 1
      || roster.sourceId !== SOURCE_ID
      || roster.resultCode !== "00"
      || !Array.isArray(roster.stations)) {
      throw new Error("KRIC roster schema is invalid");
    }
    if (rosterByRequest.has(key)) throw new Error(`duplicate provider roster: ${key}`);
    for (const station of roster.stations) {
      if (station?.mreaWideCd !== roster.mreaWideCd || station?.lnCd !== roster.lnCd) {
        throw new Error(`provider station row scope mismatch: ${key}`);
      }
      if (!operatorCodesByRequest.get(key)?.has(station?.railOprIsttCd)) {
        throw new Error(`unexpected provider operator row: ${key}`);
      }
    }
    rosterByRequest.set(key, roster);
  }
  return rosterByRequest;
}

function indexProviderScopes(providerScopes) {
  const byScopeKey = new Map();
  const operatorCodesByRequest = new Map();
  for (const scope of providerScopes) {
    const owned = scope?.regionId === "capital" && TARGET_OPERATOR_IDS.has(scope?.operatorId);
    const selectedRequest = optionalRequestKey(scope);
    if (!owned && (!selectedRequest || !SELECTED_REQUEST_KEYS.has(selectedRequest))) continue;
    validateProviderScope(scope);
    const key = scopeKey(scope);
    if (byScopeKey.has(key)) throw new Error(`duplicate provider scope: ${key}`);
    if (owned && !EXPECTED_BY_SCOPE_KEY.has(key)) throw new Error(`unknown provider scope: ${key}`);
    byScopeKey.set(key, scope);
    if (SELECTED_REQUEST_KEYS.has(requestKey(scope))) {
      const codes = operatorCodesByRequest.get(requestKey(scope)) ?? new Set();
      codes.add(scope.railOprIsttCd);
      operatorCodesByRequest.set(requestKey(scope), codes);
    }
  }
  return { byScopeKey, operatorCodesByRequest };
}

function validateProviderScope(scope) {
  for (const field of ["regionId", "operatorId", "lineId", "mreaWideCd", "lnCd", "railOprIsttCd"]) {
    requiredString(scope?.[field], `provider scope ${field}`);
  }
}

function optionalRequestKey(scope) {
  if (typeof scope?.mreaWideCd !== "string" || scope.mreaWideCd.trim() === ""
    || typeof scope?.lnCd !== "string" || scope.lnCd.trim() === "") {
    return null;
  }
  return `${scope.mreaWideCd}:${scope.lnCd}`;
}

function scopeKey(scope) {
  return [scope?.regionId, scope?.operatorId, scope?.lineId].map((value) => requiredString(value, "scope value")).join(":" );
}

function requestKey(scope) {
  return [requiredString(scope?.mreaWideCd, "mreaWideCd"), requiredString(scope?.lnCd, "lnCd")].join(":");
}

function compareScope(left, right) {
  return codepointCompare(left.regionId, right.regionId)
    || codepointCompare(left.operatorId, right.operatorId)
    || codepointCompare(left.lineId, right.lineId);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function sameScope(left, right) {
  return ["regionId", "operatorId", "lineId", "mreaWideCd", "lnCd", "railOprIsttCd"]
    .every((field) => left?.[field] === right?.[field]);
}

function sameSorted(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && [...value].sort(codepointCompare).every((entry, index) => entry === [...expected].sort(codepointCompare)[index]);
}
