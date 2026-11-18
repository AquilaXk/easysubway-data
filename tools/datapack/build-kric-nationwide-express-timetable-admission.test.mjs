import assert from "node:assert/strict";
import test from "node:test";

import { planKricNationwideTimetableCollection } from "./plan-kric-nationwide-timetable-collection.mjs";
import { buildKricNationwideExpressTimetableAdmissionContract } from "./build-kric-nationwide-express-timetable-admission.mjs";

const NOW = new Date("2026-08-24T00:00:00.000Z");
const SOURCE_ID = "kric-subway-timetable";
const SNAPSHOT_ID = "kric-subway-timetable-exp-20260824T000000000Z";
const RAW_SHA256 = "a".repeat(64);
const KORAIL_LINES = [
  ["line-051552e50435", "WS"], ["line-41a8c75ec9d8", "3"], ["line-472a81add377", "1"], ["line-54a7b980b7c3", "K2"],
  ["line-558d0bd8312d", "K1"], ["line-6e39be0cb6e2", "K4"], ["line-e4939a4b4713", "K5"], ["seoul-4", "4"],
];
const SEOUL_LINES = [
  ["line-15b3b8a93259", "7"], ["line-2b2d9eaa53d0", "8"], ["line-3f41718e0833", "6"], ["line-41a8c75ec9d8", "3"],
  ["line-472a81add377", "1"], ["line-80fc4d5350d4", "5"], ["seoul-2", "2"], ["seoul-4", "4"],
];
const INCHEON_LINES = [["line-15b3b8a93259", "7"]];

function fixture({ firstExptCd = "N", servicePatternByExptCd = [{ exptCd: "N", servicePattern: "LOCAL" }] } = {}) {
  const providerScopes = [
    ...KORAIL_LINES.map(([lineId, lnCd]) => scope("korail", lineId, "KR", lnCd)),
    ...SEOUL_LINES.map(([lineId, lnCd]) => scope("seoul-metro", lineId, "S1", lnCd)),
    ...INCHEON_LINES.map(([lineId, lnCd]) => scope("incheon-transit", lineId, "IC", lnCd)),
  ];
  const plannerInputs = {
    tally: {
      targetVersion: "2026-07-13",
      launchRequired: { requirements: providerScopes.map(({ regionId, operatorId, lineId }) => ({
        regionId, operatorId, lineId, sourceDomain: "schedule_timetable", status: "MISSING", missingKind: "NO_ADMITTED_SOURCE",
        requiredFieldCount: 3, unadmittedFields: ["service_calendar", "trip", "stop_time"],
      })) },
    },
    rosterArtifact: {
      schemaVersion: 1, artifactKind: "kric-nationwide-route-rosters", sourceId: "kric-subway-route-info", targetVersion: "2026-07-13",
      credentialRedacted: true, providerScopes, rosters: rostersFor(providerScopes),
    },
    sourceCandidates: { schemaVersion: 1, artifactKind: "production-source-candidates", candidates: [candidate()] },
  };
  const requestPlan = planKricNationwideTimetableCollection(plannerInputs);
  const responses = requestPlan.requests.map((request, index) => ({
    requestKey: request.requestKey, operation: request.operation, endpoint: request.endpoint, params: structuredClone(request.params),
    response: { header: { resultCode: "00", resultMsg: "OK" }, body: { row: [{
      railOprIsttCd: request.params.railOprIsttCd, lnCd: request.params.lnCd, stinCd: request.params.stinCd, dayCd: request.params.dayCd,
      trnNo: `train-${String(index).padStart(2, "0")}`, arvTm: "080000", dptTm: "080100", exptCd: index === 0 ? firstExptCd : "N",
    }] } },
  }));
  const base = buildKricNationwideExpressTimetableAdmissionContract({ plannerInputs, requestPlan, responses, servicePatternByExptCd, now: NOW });
  const sourceSnapshot = {
    sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, retrievedAt: "2026-08-24T00:00:00.000Z",
    rawSha256: RAW_SHA256, schemaFingerprint: "b".repeat(64), redactedRequestFingerprint: "c".repeat(64),
    sourceUpdatedAt: "2026-08-24T00:00:00.000Z", rowCount: 81, coverageCount: 27, rawByteSize: 256,
    requestPlanSha256: base.requestPlanSha256, targetSetSha256: base.targetSetSha256, eventSetSha256: base.eventSetSha256,
    servicePatternMappingSha256: base.servicePatternMappingSha256,
    previousSnapshotId: null, diffSummary: null, freshUntil: "2026-08-25T00:00:00.000Z",
  };
  return {
    plannerInputs, requestPlan, responses, servicePatternByExptCd: structuredClone(servicePatternByExptCd),
    sourceInventory: { sources: [{
      id: SOURCE_ID, fieldsProvided: ["railOprIsttCd", "trnNo", "dayCd", "dayNm", "stinCd", "lnCd", "arvTm", "dptTm", "exptCd"],
      license: { type: "KOGL-1", commercialUseAllowed: true, derivativeWorkAllowed: true, redistributionAllowed: true },
      coverageScope: { sourceDomains: ["schedule_timetable"] },
    }] },
    sourceSnapshots: [sourceSnapshot],
    rawReceipt: {
      sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, snapshotRawSha256: RAW_SHA256, rawObjectSha256: RAW_SHA256, byteSize: 256,
      rawObjectUri: "oci://axvym6vk8g7i/easysubway-datapacks/source-raw/kric-subway-timetable/20260824/raw.json",
      ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey: "source-raw/kric-subway-timetable/20260824/raw.json",
      storedAt: "2026-08-24T00:00:00.000Z", rawRetentionExpiresAt: "2026-11-22T00:00:00.000Z",
    },
    licenseDecision: {
      sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, snapshotRawSha256: RAW_SHA256, licenseId: "KOGL-1",
      commercialUseAllowed: true, derivativeWorkAllowed: true, redistributionAllowed: true, quotaDecision: "CONFIRMED",
      productionUseAllowed: true, decision: "APPROVED",
    },
  };
}

test("#454 full synthetic operation evidence stays PENDING and requires admission execution", () => {
  const result = buildKricNationwideExpressTimetableAdmissionContract({ ...fixture(), now: NOW });

  assert.equal(result.status, "PENDING");
  assert.equal(result.decision, "CONTRACT_GAP");
  assert.equal(result.sourceId, SOURCE_ID);
  assert.equal(result.targetSetCount, 27);
  assert.equal(result.requestCount, 81);
  assert.equal(result.eventCount, 81);
  assert.deepEqual(result.gaps, [{ code: "ADMISSION_EXECUTION_REQUIRED", status: "PENDING", decision: "CONTRACT_GAP" }]);
  assert.ok(!JSON.stringify(result).includes("ADMITTED"));
});

test("#454 preflight binds cardinality to the supplied planner", () => {
  const input = fixture();
  const requestPlan = {
    ...input.requestPlan,
    providerScopeCount: 1,
    stationCount: 1,
    requestCount: 3,
    requests: input.requestPlan.requests.slice(0, 3),
  };
  input.requestPlan = requestPlan;
  input.responses = input.responses.slice(0, 3);

  const unbound = buildKricNationwideExpressTimetableAdmissionContract({
    ...input,
    planCollection: () => requestPlan,
    now: NOW,
  });
  Object.assign(input.sourceSnapshots[0], {
    coverageCount: unbound.targetSetCount,
    rowCount: unbound.eventCount,
    requestPlanSha256: unbound.requestPlanSha256,
    targetSetSha256: unbound.targetSetSha256,
    eventSetSha256: unbound.eventSetSha256,
    servicePatternMappingSha256: unbound.servicePatternMappingSha256,
  });

  const accepted = buildKricNationwideExpressTimetableAdmissionContract({
    ...input,
    planCollection: () => requestPlan,
    now: NOW,
  });
  assert.equal(accepted.requestCount, 3);
  assert.deepEqual(accepted.gaps, [{ code: "ADMISSION_EXECUTION_REQUIRED", status: "PENDING", decision: "CONTRACT_GAP" }]);

  const drifted = buildKricNationwideExpressTimetableAdmissionContract({
    ...input,
    requestPlan: { ...requestPlan, requestCount: 2 },
    planCollection: () => requestPlan,
    now: NOW,
  });
  assert.ok(drifted.gaps.some((gap) => gap.code === "PLANNER_TARGET_OR_HASH_MISMATCH"));
});

test("#454 preflight fails closed for planner/response/event mapping/snapshot/legal OCI and lineage drift", () => {
  const scenarios = [
    ["plan hash", (input) => { input.requestPlan.requests[0].params.dayCd = "0"; }, "PLANNER_TARGET_OR_HASH_MISMATCH"],
    ["response scope", (input) => { input.responses[0].response.body.row[0].stinCd = "wrong"; }, "RESPONSE_REQUEST_SCOPE_MISMATCH"],
    ["result code", (input) => { input.responses[0].response.header.resultCode = "03"; }, "RESPONSE_SET_INCOMPLETE"],
    ["missing response", (input) => { input.responses.pop(); }, "RESPONSE_SET_INCOMPLETE"],
    ["empty response rows", (input) => { input.responses[0].response.body.row = []; }, "RESPONSE_SET_INCOMPLETE"],
    ["blank train number", (input) => { input.responses[0].response.body.row[0].trnNo = " "; }, "TRAIN_EVENT_IDENTITY_MISMATCH"],
    ["duplicate event", (input) => { input.responses[0].response.body.row.push(structuredClone(input.responses[0].response.body.row[0])); }, "TRAIN_EVENT_IDENTITY_MISMATCH"],
    ["closed expt map", (input) => { input.servicePatternByExptCd = []; }, "SERVICE_PATTERN_MAPPING_INCOMPLETE"],
    ["future snapshot", (input) => { input.sourceSnapshots[0].retrievedAt = "2026-08-25T00:00:00.000Z"; }, "SNAPSHOT_NOT_CURRENT"],
    ["license", (input) => { input.licenseDecision.redistributionAllowed = false; }, "LICENSE_PRODUCTION_DECISION_MISSING"],
    ["license inventory binding", (input) => { input.licenseDecision.licenseId = "PUBLIC_DATA_FREE_USE"; }, "LICENSE_PRODUCTION_DECISION_MISSING"],
    ["OCI", (input) => { input.rawReceipt.rawObjectUri = "s3://wrong/raw.json"; }, "OCI_RAW_RECEIPT_MISMATCH"],
    ["future OCI store", (input) => { input.rawReceipt.storedAt = "2026-08-24T00:00:01.000Z"; }, "OCI_RAW_RECEIPT_MISMATCH"],
    ["lineage", (input) => { input.sourceSnapshots[0].schemaFingerprint = "wrong"; }, "SOURCE_LINEAGE_OR_DIFF_INVALID"],
  ];
  for (const [label, mutate, code] of scenarios) {
    const input = fixture();
    mutate(input);
    const result = buildKricNationwideExpressTimetableAdmissionContract({ ...input, now: NOW });
    assert.equal(result.status, "PENDING", label);
    assert.equal(result.decision, "CONTRACT_GAP", label);
    assert.ok(result.gaps.some((gap) => gap.code === code), label);
    assert.ok(!JSON.stringify(result).includes("ADMITTED"), label);
  }
});

test("#454 malformed source inventory fails closed as an identity mismatch", () => {
  for (const sourceInventory of [null, {}, { sources: null }, { sources: [null] }, { sources: ["not-an-inventory-source"] }]) {
    const result = buildKricNationwideExpressTimetableAdmissionContract({ ...fixture(), sourceInventory, now: NOW });
    assert.equal(result.status, "PENDING");
    assert.equal(result.decision, "CONTRACT_GAP");
    assert.ok(result.gaps.some((gap) => gap.code === "SOURCE_INVENTORY_IDENTITY_MISMATCH"));
  }
});

test("#454 exptCd null은 명시적인 닫힌 mapping이 있을 때만 normal-service event로 허용한다", () => {
  const withNull = fixture({
    firstExptCd: null,
    servicePatternByExptCd: [{ exptCd: null, servicePattern: "LOCAL" }, { exptCd: "N", servicePattern: "LOCAL" }],
  });
  const admittedOnlyToExecution = buildKricNationwideExpressTimetableAdmissionContract({ ...withNull, now: NOW });
  assert.equal(admittedOnlyToExecution.status, "PENDING");
  assert.deepEqual(admittedOnlyToExecution.gaps, [{ code: "ADMISSION_EXECUTION_REQUIRED", status: "PENDING", decision: "CONTRACT_GAP" }]);

  const scenarios = [
    ["missing null mapping", fixture({ firstExptCd: null }), [{ exptCd: "N", servicePattern: "LOCAL" }]],
    ["extra null mapping", fixture(), [{ exptCd: "N", servicePattern: "LOCAL" }, { exptCd: null, servicePattern: "LOCAL" }]],
    ["duplicate null mapping", fixture({ firstExptCd: null, servicePatternByExptCd: [{ exptCd: null, servicePattern: "LOCAL" }, { exptCd: null, servicePattern: "LOCAL" }, { exptCd: "N", servicePattern: "LOCAL" }] }), null],
  ];
  for (const [label, input, mapping] of scenarios) {
    if (mapping != null) input.servicePatternByExptCd = mapping;
    const result = buildKricNationwideExpressTimetableAdmissionContract({ ...input, now: NOW });
    assert.equal(result.status, "PENDING", label);
    assert.equal(result.decision, "CONTRACT_GAP", label);
    assert.ok(result.gaps.some((gap) => gap.code === "SERVICE_PATTERN_MAPPING_INCOMPLETE"), label);
  }
});

function scope(operatorId, lineId, railOprIsttCd, lnCd) {
  return { regionId: "capital", operatorId, lineId, mreaWideCd: "01", railOprIsttCd, lnCd };
}

function rostersFor(providerScopes) {
  const byRequest = new Map();
  for (const [index, providerScope] of providerScopes.entries()) {
    const key = `${providerScope.mreaWideCd}:${providerScope.lnCd}`;
    const roster = byRequest.get(key) ?? { schemaVersion: 1, artifactKind: "kric-route-roster", sourceId: "kric-subway-route-info", resultCode: "00", mreaWideCd: "01", lnCd: providerScope.lnCd, stations: [] };
    const stationCodes = providerScope.operatorId === "incheon-transit"
      ? ["751", "752", "753", "754", "755", "756", "757", "758", "759", "760", "761"]
      : [`station-${String(index).padStart(2, "0")}`];
    for (const stinCd of stationCodes) {
      roster.stations.push({ mreaWideCd: "01", railOprIsttCd: providerScope.railOprIsttCd, lnCd: providerScope.lnCd, stinCd });
    }
    byRequest.set(key, roster);
  }
  return [...byRequest.values()];
}

function candidate() {
  return {
    id: "kric-subway-timetable-exp", domain: "schedule_timetable", productionInventoryReferenceId: SOURCE_ID,
    operation: {
      method: "GET", endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetableExp",
      auth: { env: "KRIC_SERVICE_KEY", placement: "query", parameter: "serviceKey" },
      requiredParameters: ["serviceKey", "format", "railOprIsttCd", "dayCd", "lnCd", "stinCd"],
      responseEnvelope: "{header:{resultCode,resultMsg},body:row[]}", secretPolicy: "env-only-redacted-output",
    },
  };
}
