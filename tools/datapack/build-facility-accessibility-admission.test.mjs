import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildFacilityAccessibilityAdmission,
  canonicalFacilityAccessibilityAdmissionJson,
} from "./build-facility-accessibility-admission.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";

const CAPTURED_AT = "2026-08-13T20:00:00.000Z";
const FRESH_UNTIL = "2026-08-15T20:00:00.000Z";
const OBSERVED_AT = "2026-08-14T00:00:00.000Z";

test("eligible official facility와 exhaustive absence를 Data #8 evidence로 투영한다", () => {
  const input = validInput();
  input.facilityRows = [
    facilityRow({ strictRouteEligible: true, strictRouteEligibleReason: "OFFICIAL_OPERATION_AVAILABLE" }),
    ...requiredAbsenceRows({ stationId: "station-b", providerRecordHash: "b".repeat(64) }),
  ];

  const result = buildFacilityAccessibilityAdmission(input);

  assert.equal(result.decision, "GO");
  assert.deepEqual(result.cells.map(({ stationLineId, state, admissionReason }) => ({
    stationLineId, state, admissionReason,
  })), [{
    stationLineId: "station-a:line-1",
    state: "ADMITTED_FACILITY_PATH",
    admissionReason: "OFFICIAL_FACILITY_OPERATION_AVAILABLE",
  }, {
    stationLineId: "station-b:line-1",
    state: "ADMITTED_VERIFIED_ABSENCE",
    admissionReason: "OFFICIAL_REQUIRED_FACILITIES_ABSENT",
  }]);
  assert.deepEqual(result.materializerEvidenceRows.map(({ stationId, state, evidenceKind }) => ({
    stationId, state, evidenceKind,
  })), [{
    stationId: "station-a",
    state: "VERIFIED_PRESENT",
    evidenceKind: "OBSERVED",
  }, {
    stationId: "station-b",
    state: "VERIFIED_ABSENT",
    evidenceKind: "EXHAUSTIVE_LIST",
  }]);
  const materialized = materializeStationLineAccessibility({
    candidate: input.candidate,
    stationLines: input.stationLines,
    evidenceRows: result.materializerEvidenceRows,
    observedAt: input.observedAt,
  });
  assert.deepEqual(materialized.rows.filter(({ domain }) => domain === "FACILITY").map(({ state }) => state), [
    "VERIFIED_PRESENT", "VERIFIED_ABSENT",
  ]);

  const withStaleDuplicate = validInput();
  withStaleDuplicate.sources.push(sourceRegistration({
    sourceId: "kric-facility-old",
    snapshotId: "kric-facility-old",
    rawSha256: "3".repeat(64),
    freshUntil: OBSERVED_AT,
  }));
  withStaleDuplicate.facilityRows = [
    facilityRow({ strictRouteEligible: true }),
    ...requiredAbsenceRows({ stationId: "station-b", providerRecordHash: "b".repeat(64) }),
    facilityRow({
      stationId: "station-b",
      facilityType: "ELEVATOR",
      evidenceKind: "NOT_EXISTS",
      installationStatus: "NOT_INSTALLED",
      operationalStatus: "NOT_APPLICABLE",
      statusMeaning: "EXHAUSTIVE_LIST_ABSENCE",
      sourceId: "kric-facility-old",
      sourceSnapshotId: "kric-facility-old",
      providerRecordHash: "3".repeat(64),
      strictRouteEligible: false,
      strictRouteEligibleReason: "FACILITY_NOT_INSTALLED",
    }),
  ];
  assert.equal(buildFacilityAccessibilityAdmission(withStaleDuplicate).decision, "GO");

  const conflicting = validInput();
  conflicting.facilityRows = [
    facilityRow({ strictRouteEligible: true }),
    ...requiredAbsenceRows({ stationId: "station-b", providerRecordHash: "b".repeat(64) }),
    facilityRow({
      stationId: "station-b",
      facilityType: "ELEVATOR",
      evidenceKind: "EXISTS",
      installationStatus: "NOT_INSTALLED",
      operationalStatus: "NOT_APPLICABLE",
      statusMeaning: "CONFLICTING_OBSERVATION",
      providerRecordHash: "e".repeat(64),
      strictRouteEligible: false,
      strictRouteEligibleReason: "CONFLICTING_FACILITY_EVIDENCE",
    }),
  ];
  const conflictingResult = buildFacilityAccessibilityAdmission(conflicting);
  assert.equal(conflictingResult.decision, "NO_GO");
  assert.equal(conflictingResult.stateSummary.ADMITTED_VERIFIED_ABSENCE, 0);
});

test("current route-ineligible status는 UNKNOWN이고 evidence 부재는 MISSING이다", () => {
  const input = validInput();
  input.facilityRows = [
    facilityRow({
      operationalStatus: "UNKNOWN",
      strictRouteEligible: false,
      strictRouteEligibleReason: "OPERATION_STATUS_UNKNOWN",
      statusMeaning: "STATIC_LOCATION",
    }),
    ...requiredAbsenceRows().filter(({ facilityType }) => facilityType !== "ELEVATOR"),
    facilityRow({
      facilityType: "ACCESSIBILITY_STATUS_PROBE",
      sourceId: "seoul-accessibility",
      sourceSnapshotId: "seoul-accessibility-current",
      providerRecordHash: "c".repeat(64),
      strictRouteEligible: false,
      strictRouteEligibleReason: "STATUS_PROBE_NOT_ROUTE_EVIDENCE",
    }),
  ];

  const result = buildFacilityAccessibilityAdmission(input);

  assert.equal(result.decision, "NO_GO");
  assert.deepEqual(result.cells.map(({ state, admissionReason }) => ({ state, admissionReason })), [{
    state: "UNKNOWN",
    admissionReason: "OPERATION_STATUS_UNKNOWN",
  }, {
    state: "MISSING",
    admissionReason: "FACILITY_EVIDENCE_MISSING",
  }]);
  assert.equal(result.materializerEvidenceRows.length, 1);
  const materialized = materializeStationLineAccessibility({
    candidate: input.candidate,
    stationLines: input.stationLines,
    evidenceRows: result.materializerEvidenceRows,
    observedAt: input.observedAt,
  });
  assert.deepEqual(materialized.rows.filter(({ domain }) => domain === "FACILITY").map(({ state }) => state), [
    "UNKNOWN", "MISSING",
  ]);
});

test("stale source와 candidate/source/station-line identity drift를 fail closed한다", () => {
  const stale = validInput();
  stale.stationLines = stale.stationLines.filter(({ stationId }) => stationId === "station-a");
  refreshCandidate(stale);
  stale.facilityRows = [facilityRow({ operationalStatus: "UNKNOWN", strictRouteEligible: false })];
  stale.observedAt = FRESH_UNTIL;
  const staleResult = buildFacilityAccessibilityAdmission(stale);
  assert.equal(staleResult.cells[0].state, "STALE");
  assert.equal(staleResult.decision, "NO_GO");

  const badCandidate = validInput();
  badCandidate.candidate.stationSetSha256 = "0".repeat(64);
  assert.throws(() => buildFacilityAccessibilityAdmission(badCandidate), /station set identity mismatch/);

  const badSource = validInput();
  badSource.facilityRows = [facilityRow({ sourceSnapshotId: "other-snapshot" })];
  assert.throws(() => buildFacilityAccessibilityAdmission(badSource), /source identity mismatch/);

  const unmapped = validInput();
  unmapped.facilityRows = [facilityRow({ stationId: "station-z" })];
  assert.throws(() => buildFacilityAccessibilityAdmission(unmapped), /unmapped facility evidence/);

  const futureSource = validInput();
  futureSource.sources[0].capturedAt = "2026-08-14T00:00:00.001Z";
  futureSource.facilityRows = [facilityRow({ strictRouteEligible: true })];
  assert.throws(() => buildFacilityAccessibilityAdmission(futureSource), /source is future-dated/);

  const futureRow = validInput();
  futureRow.facilityRows = [facilityRow({
    strictRouteEligible: true,
    verifiedAt: "2026-08-14T00:00:00.001Z",
    retrievedAt: "2026-08-14T00:00:00.001Z",
  })];
  assert.throws(() => buildFacilityAccessibilityAdmission(futureRow), /row is future-dated/);

  const nonOverlapping = validInput();
  nonOverlapping.stationLines = nonOverlapping.stationLines.filter(({ stationId }) => stationId === "station-a");
  refreshCandidate(nonOverlapping);
  nonOverlapping.sources = [
    sourceRegistration({ capturedAt: "2026-08-10T00:00:00.000Z", freshUntil: "2026-08-11T00:00:00.000Z" }),
    sourceRegistration({
      sourceId: "seoul-accessibility",
      snapshotId: "seoul-accessibility-current",
      rawSha256: "2".repeat(64),
      capturedAt: "2026-08-12T00:00:00.000Z",
      freshUntil: "2026-08-13T00:00:00.000Z",
      provenanceId: "seoul-official-source",
      licenseId: "public-data-free-use",
    }),
  ];
  nonOverlapping.facilityRows = requiredAbsenceRows().map((row, index) => index === 0 ? row : {
    ...row,
    sourceId: "seoul-accessibility",
    sourceSnapshotId: "seoul-accessibility-current",
  });
  const nonOverlappingResult = buildFacilityAccessibilityAdmission(nonOverlapping);
  assert.equal(nonOverlappingResult.cells[0].state, "STALE");
  assert.doesNotThrow(() => materializeStationLineAccessibility({
    candidate: nonOverlapping.candidate,
    stationLines: nonOverlapping.stationLines,
    evidenceRows: nonOverlappingResult.materializerEvidenceRows,
    observedAt: nonOverlapping.observedAt,
  }));
});

test("output은 input order와 input object mutation에 독립적이다", () => {
  const first = validInput();
  first.facilityRows = [
    facilityRow({ strictRouteEligible: true }),
    ...requiredAbsenceRows({ stationId: "station-b", providerRecordHash: "b".repeat(64) }),
  ];
  const second = structuredClone(first);
  second.stationLines.reverse();
  second.sources.reverse();
  second.facilityRows.reverse();
  const before = structuredClone(first);

  const firstResult = buildFacilityAccessibilityAdmission(first);
  const secondResult = buildFacilityAccessibilityAdmission(second);

  assert.deepEqual(first, before);
  assert.equal(
    canonicalFacilityAccessibilityAdmissionJson(firstResult),
    canonicalFacilityAccessibilityAdmissionJson(secondResult),
  );
  assert.match(firstResult.admissionDigest, /^[a-f0-9]{64}$/);

  const tiedFirst = validInput();
  tiedFirst.stationLines = tiedFirst.stationLines.filter(({ stationId }) => stationId === "station-a");
  refreshCandidate(tiedFirst);
  tiedFirst.facilityRows = [
    facilityRow({
      facilityType: "ACCESSIBILITY_STATUS_PROBE",
      strictRouteEligible: false,
      strictRouteEligibleReason: "Z_REASON",
      evidenceHash: "1".repeat(64),
    }),
    facilityRow({
      facilityType: "ACCESSIBILITY_STATUS_PROBE",
      strictRouteEligible: false,
      strictRouteEligibleReason: "A_REASON",
      evidenceHash: "2".repeat(64),
    }),
  ];
  const tiedSecond = structuredClone(tiedFirst);
  tiedSecond.facilityRows.reverse();
  assert.equal(
    canonicalFacilityAccessibilityAdmissionJson(buildFacilityAccessibilityAdmission(tiedFirst)),
    canonicalFacilityAccessibilityAdmissionJson(buildFacilityAccessibilityAdmission(tiedSecond)),
  );
});

function validInput() {
  const value = {
    candidate: {
      candidateId: "candidate-capital-facility-1",
      stationSetSha256: "",
      sourceSetSha256: "",
      mappingContractVersion: "station-line-v1",
      materializerVersion: "1",
    },
    observedAt: OBSERVED_AT,
    stationLines: [
      { stationId: "station-b", lineId: "line-1", operatorId: "operator-1" },
      { stationId: "station-a", lineId: "line-1", operatorId: "operator-1" },
    ],
    sources: [
      sourceRegistration(),
      sourceRegistration({
        sourceId: "seoul-accessibility",
        snapshotId: "seoul-accessibility-current",
        rawSha256: "2".repeat(64),
        provenanceId: "seoul-official-source",
        licenseId: "public-data-free-use",
      }),
    ],
    facilityRows: [],
  };
  refreshCandidate(value);
  return value;
}

function refreshCandidate(input) {
  const stationIds = [...new Set(input.stationLines.map(({ stationId }) => stationId))].sort(compareBytes);
  input.candidate.stationSetSha256 = sha256(canonicalJson(stationIds));
  input.candidate.sourceSetSha256 = "f".repeat(64);
}

function sourceRegistration(overrides = {}) {
  return {
    sourceId: "kric-facility",
    snapshotId: "kric-facility-current",
    sourceSetSha256: "f".repeat(64),
    rawSha256: "1".repeat(64),
    capturedAt: CAPTURED_AT,
    freshUntil: FRESH_UNTIL,
    productionUseAllowed: true,
    provenanceId: "kric-official-source",
    licenseId: "kogl-1",
    ...overrides,
  };
}

function facilityRow(overrides = {}) {
  return {
    stationId: "station-a",
    lineId: "line-1",
    facilityType: "ELEVATOR",
    evidenceKind: "EXISTS",
    sourceId: "kric-facility",
    sourceSnapshotId: "kric-facility-current",
    providerRecordHash: "a".repeat(64),
    evidenceHash: "d".repeat(64),
    provenanceKind: "OFFICIAL_SOURCE",
    installationStatus: "INSTALLED",
    operationalStatus: "AVAILABLE",
    statusMeaning: "REALTIME_OPERATION",
    confidence: 100,
    verifiedAt: CAPTURED_AT,
    retrievedAt: CAPTURED_AT,
    strictRouteEligible: true,
    strictRouteEligibleReason: "OFFICIAL_OPERATION_AVAILABLE",
    ...overrides,
  };
}

function requiredAbsenceRows(overrides = {}) {
  return ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"].map((facilityType) => facilityRow({
    facilityType,
    evidenceKind: "NOT_EXISTS",
    installationStatus: "NOT_INSTALLED",
    operationalStatus: "NOT_APPLICABLE",
    statusMeaning: "EXHAUSTIVE_LIST_ABSENCE",
    strictRouteEligible: false,
    strictRouteEligibleReason: "FACILITY_NOT_INSTALLED",
    ...overrides,
  }));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalObject));
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  }
  return value;
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
