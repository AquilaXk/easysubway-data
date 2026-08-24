import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTE_ROSTER_ADMISSION_SCOPE_SHA256,
  buildKricNationwideRouteRosterAdmissionContract,
} from "./build-kric-nationwide-route-roster-admission.mjs";
import { projectKricStationLineMembership } from "./project-kric-station-line-membership.mjs";

const SOURCE_ID = "kric-subway-route-info";
const SNAPSHOT_ID = "kric-subway-route-info-20260824T000000000Z";
const RAW_SHA256 = "a".repeat(64);
const NOW = new Date("2026-08-24T00:00:00.000Z");
const SCOPES = [
  ["korail", "line-051552e50435", "WS", "KR"], ["korail", "line-41a8c75ec9d8", "3", "KR"],
  ["korail", "line-472a81add377", "1", "KR"], ["korail", "line-54a7b980b7c3", "K2", "KR"],
  ["korail", "line-558d0bd8312d", "K1", "KR"], ["korail", "line-6e39be0cb6e2", "K4", "KR"],
  ["korail", "line-e4939a4b4713", "K5", "KR"], ["korail", "seoul-4", "4", "KR"],
  ["operator-c361f9fc17e9", "line-2b2d9eaa53d0", "8", "NU"], ["operator-c361f9fc17e9", "seoul-4", "4", "NU"],
  ["seoul-metro", "line-15b3b8a93259", "7", "S1"], ["seoul-metro", "line-2b2d9eaa53d0", "8", "S1"],
  ["seoul-metro", "line-3f41718e0833", "6", "S1"], ["seoul-metro", "line-41a8c75ec9d8", "3", "S1"],
  ["seoul-metro", "line-472a81add377", "1", "S1"], ["seoul-metro", "line-80fc4d5350d4", "5", "S1"],
  ["seoul-metro", "seoul-2", "2", "S1"], ["seoul-metro", "seoul-4", "4", "S1"],
].map(([operatorId, lineId, lnCd, railOprIsttCd]) => ({
  regionId: "capital", operatorId, lineId, mreaWideCd: "01", lnCd, railOprIsttCd,
}));

function fixture() {
  const tally = {
    targetVersion: "2026-07-13",
    launchRequired: { requirements: SCOPES.map(({ operatorId, lineId }) => ({
      regionId: "capital", operatorId, lineId, sourceDomain: "station_line_membership", status: "MISSING",
      requiredFieldCount: 3, unadmittedFields: ["line", "station_name", "station_code"],
    })) },
  };
  const rosters = [...new Map(SCOPES.map((scope) => [`${scope.mreaWideCd}:${scope.lnCd}`, scope])).entries()]
    .map(([key]) => {
      const [mreaWideCd, lnCd] = key.split(":");
      return {
        schemaVersion: 1, artifactKind: "kric-route-roster", sourceId: SOURCE_ID, mreaWideCd, lnCd, resultCode: "00",
        stations: SCOPES.filter((scope) => scope.mreaWideCd === mreaWideCd && scope.lnCd === lnCd).map((scope) => ({
          railOprIsttCd: scope.railOprIsttCd, mreaWideCd, lnCd, stinCd: `${scope.railOprIsttCd}-01`, stinNm: `${scope.railOprIsttCd} 역`, stinConsOrdr: 1,
        })),
      };
    });
  const rosterArtifact = {
    schemaVersion: 1, artifactKind: "kric-nationwide-route-rosters", sourceId: SOURCE_ID,
    targetVersion: tally.targetVersion, credentialRedacted: true, capturedAt: "2026-08-24T00:00:00.000Z",
    snapshotId: SNAPSHOT_ID, providerScopes: structuredClone(SCOPES), rosters,
  };
  const projection = projectKricStationLineMembership({ tally, rosterArtifact });
  const sourceSnapshot = {
    sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, retrievedAt: "2026-08-24T00:00:00.000Z",
    rawSha256: RAW_SHA256, schemaFingerprint: "b".repeat(64), redactedRequestFingerprint: "c".repeat(64),
    sourceUpdatedAt: "2026-08-24T00:00:00.000Z", rowCount: projection.records.length, coverageCount: 18,
    previousSnapshotId: null, diffSummary: null, freshUntil: "2026-08-25T00:00:00.000Z",
  };
  return {
    tally, rosterArtifact, projection,
    sourceInventory: { sources: [{
      id: SOURCE_ID, productionUseAllowed: true,
      fieldsProvided: ["line", "station_name", "station_code"],
      coverageScope: { sourceDomains: ["station_line_membership"] },
    }] },
    sourceSnapshots: [sourceSnapshot],
    rawReceipt: {
      sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, snapshotRawSha256: RAW_SHA256,
      rawObjectUri: "oci://axvym6vk8g7i/easysubway-datapacks/source-raw/kric-subway-route-info/20260824/raw.json",
      rawObjectSha256: RAW_SHA256, ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks",
      objectKey: "source-raw/kric-subway-route-info/20260824/raw.json", byteSize: 128,
      storedAt: "2026-08-24T00:00:01.000Z", rawRetentionExpiresAt: "2026-11-22T00:00:00.000Z",
    },
    licenseDecision: {
      sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, snapshotRawSha256: RAW_SHA256,
      licenseId: "KOGL-1", commercialUseAllowed: true, derivativeWorkAllowed: true,
      redistributionAllowed: true, quotaDecision: "CONFIRMED", productionUseAllowed: true, decision: "APPROVED",
    },
  };
}

test("#455 exact 18 scope current-admission preflight는 모든 합성 증거가 있어도 승격 없이 PENDING만 반환한다", () => {
  const result = buildKricNationwideRouteRosterAdmissionContract({ ...fixture(), now: NOW });

  assert.equal(result.status, "PENDING");
  assert.equal(result.decision, "CONTRACT_GAP");
  assert.equal(result.sourceId, SOURCE_ID);
  assert.equal(result.scopeCount, 18);
  assert.equal(result.scopeSetSha256, ROUTE_ROSTER_ADMISSION_SCOPE_SHA256);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].code, "ADMISSION_EXECUTION_REQUIRED");
  assert.ok(!JSON.stringify(result).includes("ADMITTED"));
});

test("#455 preflight는 source/scope/projection/current snapshot/legal OCI lineage drift를 모두 deterministic CONTRACT_GAP으로 유지한다", () => {
  const scenarios = [
    ["source identity", (input) => { input.sourceInventory.sources[0].id = "wrong"; }, "SOURCE_INVENTORY_IDENTITY_MISMATCH"],
    ["required field", (input) => { input.sourceInventory.sources[0].fieldsProvided.pop(); }, "SOURCE_REQUIRED_FIELDS_INCOMPLETE"],
    ["result code", (input) => { input.rosterArtifact.rosters[0].resultCode = "03"; }, "TALLY_ROSTER_PROJECTION_MISMATCH"],
    ["projection binding", (input) => { input.projection.records[0].station_code = "drift"; }, "PROJECTION_TALLY_BINDING_MISMATCH"],
    ["future snapshot", (input) => { input.sourceSnapshots[0].retrievedAt = "2026-08-25T00:00:00.000Z"; }, "SNAPSHOT_NOT_CURRENT"],
    ["license decision", (input) => { input.licenseDecision.redistributionAllowed = false; }, "LICENSE_PRODUCTION_DECISION_MISSING"],
    ["OCI receipt", (input) => { input.rawReceipt.rawObjectUri = "s3://wrong/raw.json"; }, "OCI_RAW_RECEIPT_MISMATCH"],
    ["lineage diff", (input) => { input.sourceSnapshots[0].schemaFingerprint = "not-a-hash"; }, "SOURCE_LINEAGE_OR_DIFF_INVALID"],
  ];
  for (const [label, mutate, code] of scenarios) {
    const input = fixture();
    mutate(input);
    const result = buildKricNationwideRouteRosterAdmissionContract({ ...input, now: NOW });
    assert.equal(result.status, "PENDING", label);
    assert.equal(result.decision, "CONTRACT_GAP", label);
    assert.ok(result.gaps.some((gap) => gap.code === code), label);
    assert.ok(!JSON.stringify(result).includes("ADMITTED"), label);
  }
});

test("scope hash는 exact 18 provider/operator binding에서만 재현된다", () => {
  const input = fixture();
  input.tally.launchRequired.requirements[0].lineId = "wrong-line";
  const result = buildKricNationwideRouteRosterAdmissionContract({ ...input, now: NOW });
  assert.equal(result.scopeSetSha256, "563a8aaac28955b053f032ec3d9e989d9ad3006685f6d69efb6d3ff5ae6963ae");
  assert.equal(result.scopeSetSha256, ROUTE_ROSTER_ADMISSION_SCOPE_SHA256);
  assert.ok(result.gaps.some((gap) => gap.code === "TALLY_ROSTER_PROJECTION_MISMATCH"));
});
