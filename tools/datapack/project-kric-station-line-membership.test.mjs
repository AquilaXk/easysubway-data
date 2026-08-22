import assert from "node:assert/strict";
import test from "node:test";

import { projectKricStationLineMembership } from "./project-kric-station-line-membership.mjs";

const TARGET_VERSION = "2026-07-13";
const SOURCE_ID = "kric-subway-route-info";
const SCOPES = [
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

function fixture() {
  const requirements = SCOPES.map(({ operatorId, lineId }) => ({
    regionId: "capital",
    operatorId,
    lineId,
    sourceDomain: "station_line_membership",
    status: "MISSING",
    requiredFieldCount: 3,
    unadmittedFields: ["line", "station_name", "station_code"],
  }));
  const rosters = [...new Map(SCOPES.map((scope) => [`${scope.mreaWideCd}:${scope.lnCd}`, scope])).entries()]
    .map(([key, request]) => {
      const [mreaWideCd, lnCd] = key.split(":");
      const scopes = SCOPES.filter((scope) => scope.mreaWideCd === mreaWideCd && scope.lnCd === lnCd);
      return {
        schemaVersion: 1,
        artifactKind: "kric-route-roster",
        sourceId: SOURCE_ID,
        mreaWideCd,
        lnCd,
        resultCode: "00",
        stations: scopes.flatMap(({ railOprIsttCd }) => [
          { railOprIsttCd, mreaWideCd, lnCd, stinCd: `${railOprIsttCd}-02`, stinNm: `${railOprIsttCd} 두번째`, stinConsOrdr: 2 },
          { railOprIsttCd, mreaWideCd, lnCd, stinCd: `${railOprIsttCd}-01`, stinNm: `${railOprIsttCd} 첫번째`, stinConsOrdr: 1 },
        ]),
      };
    });
  return {
    tally: { targetVersion: TARGET_VERSION, launchRequired: { requirements } },
    rosterArtifact: {
      schemaVersion: 1,
      artifactKind: "kric-nationwide-route-rosters",
      sourceId: SOURCE_ID,
      targetVersion: TARGET_VERSION,
      credentialRedacted: true,
      providerScopes: structuredClone(SCOPES),
      rosters,
    },
  };
}

test("exact 18 PK의 KRIC roster를 canonical station-line projection으로 결정적으로 투영한다", () => {
  const { tally, rosterArtifact } = fixture();
  const result = projectKricStationLineMembership({ tally, rosterArtifact });

  assert.equal(result.artifactKind, "kric-station-line-membership-projection");
  assert.equal(result.projectionOnly, true);
  assert.equal(result.targetVersion, TARGET_VERSION);
  assert.equal(result.sourceId, SOURCE_ID);
  assert.equal(result.records.length, 36);
  assert.deepEqual(
    result.records.map(({ line, station_name, station_code, sourceId, provider }) => ({
      line, station_name, station_code, sourceId, provider,
    })),
    [...result.records]
      .sort((left, right) => `${left.regionId}\0${left.operatorId}\0${left.line}\0${left.station_code}`
        .localeCompare(`${right.regionId}\0${right.operatorId}\0${right.line}\0${right.station_code}`, "en"))
      .map(({ line, station_name, station_code, sourceId, provider }) => ({ line, station_name, station_code, sourceId, provider })),
  );
  assert.ok(result.records.every((record) => (
    record.sourceDomain === "station_line_membership"
      && record.sourceId === SOURCE_ID
      && record.provider.mreaWideCd === "01"
      && !("admission" in record)
      && !("freshUntil" in record)
      && !("rawObjectUri" in record)
  )));
});

test("provider scope JSON key order와 unrelated roster detail은 projection을 막지 않는다", () => {
  const input = fixture();
  const original = input.rosterArtifact.providerScopes[0];
  input.rosterArtifact.providerScopes[0] = {
    lineId: original.lineId,
    regionId: original.regionId,
    operatorId: original.operatorId,
    railOprIsttCd: original.railOprIsttCd,
    lnCd: original.lnCd,
    mreaWideCd: original.mreaWideCd,
  };
  input.rosterArtifact.providerScopes.push({
    regionId: "busan", operatorId: "unrelated", lineId: "unrelated-line",
    mreaWideCd: "02", lnCd: "9", railOprIsttCd: "UX",
  });
  input.rosterArtifact.providerScopes.push({
    regionId: "capital", operatorId: "incheon-transit", lineId: "line-15b3b8a93259",
    mreaWideCd: "01", lnCd: "7", railOprIsttCd: "IC",
  });
  input.rosterArtifact.rosters.find((roster) => roster.lnCd === "7").stations.push({
    railOprIsttCd: "IC", mreaWideCd: "01", lnCd: "7", stinCd: "IC-01", stinNm: "known non-target", stinConsOrdr: 1,
  });
  input.rosterArtifact.rosters.push({ artifactKind: "unrelated-invalid" });

  assert.equal(projectKricStationLineMembership(input).records.length, 36);
});

test("exact cohort, provider scope, result row 및 station identity drift를 fail closed 한다", () => {
  const scenarios = [
    ["selected PK duplicate", (input) => input.tally.launchRequired.requirements.push(structuredClone(input.tally.launchRequired.requirements[0])), /exactly 18/],
    ["selected provider scope missing", (input) => { input.rosterArtifact.providerScopes.pop(); }, /provider scope set/],
    ["provider operator row missing", (input) => { input.rosterArtifact.rosters.find((roster) => roster.lnCd === "WS").stations = []; }, /provider station rows are missing/],
    ["duplicate station code", (input) => {
      const roster = input.rosterArtifact.rosters.find((entry) => entry.lnCd === "WS");
      roster.stations[1].stinCd = roster.stations[0].stinCd;
    }, /duplicate station code/],
    ["owned boundary unknown scope", (input) => input.rosterArtifact.providerScopes.push({
      regionId: "capital", operatorId: "korail", lineId: "unknown-line",
      mreaWideCd: "01", lnCd: "ZZ", railOprIsttCd: "KR",
    }), /unknown provider scope/],
    ["selected request unexpected operator row", (input) => input.rosterArtifact.rosters.find((roster) => roster.lnCd === "WS").stations.push({
      railOprIsttCd: "ZZ", mreaWideCd: "01", lnCd: "WS", stinCd: "ZZ-01", stinNm: "unexpected", stinConsOrdr: 1,
    }), /unexpected provider operator row/],
    ["top artifact schema version", (input) => { input.rosterArtifact.schemaVersion = 2; }, /roster artifact identity/],
    ["selected roster schema version", (input) => { input.rosterArtifact.rosters.find((roster) => roster.lnCd === "WS").schemaVersion = 2; }, /roster schema/],
    ["non-current admission claim", (input) => { input.tally.launchRequired.requirements[0].status = "INVENTORY_ADMITTED"; }, /must be MISSING/],
  ];
  for (const [label, mutate, expected] of scenarios) {
    const input = fixture();
    mutate(input);
    assert.throws(() => projectKricStationLineMembership(input), expected, label);
  }
});
