import assert from "node:assert/strict";
import test from "node:test";

import { deriveAccessibilityEligibility } from "./build-route-accessibility-eligibility.mjs";

const HASH = "a".repeat(64);

function input(overrides = {}) {
  return {
    final: { candidate: { candidateId: "candidate" }, gates: Object.fromEntries(["sourceFreshness", "stationLineAccessibility", "routeEdgeEvaluation", "artifactInventory"].map((key) => [key, { state: "PASS" }])) },
    station: { rows: [{}], materializationDigest: HASH, stateSummary: { VERIFIED_PRESENT: 0, VERIFIED_ABSENT: 0, NOT_APPLICABLE: 0, UNVERIFIED_EVIDENCE_BLOCKED: 1, UNKNOWN: 0, MISSING: 0, STALE: 0 } },
    route: { results: [{ materializationCells: [] }], evaluationDigest: "b".repeat(64), eligible: true, stateSummary: { PASS: 0, BLOCKED: 1, NOT_APPLICABLE: 0, UNKNOWN: 0, MISSING: 0, STALE: 0, NOT_EVALUATED: 0 } },
    stationEvidenceBytes: Buffer.from("station"), routeEvidenceBytes: Buffer.from("route"),
    ...overrides,
  };
}

test("terminal FACILITY blocked completeness는 BLOCKED count를 보존한 ELIGIBLE projection이다", () => {
  const report = deriveAccessibilityEligibility(input());
  assert.equal(report.decision, "ELIGIBLE");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.stationLineAccessibility.stateSummary.UNVERIFIED_EVIDENCE_BLOCKED, 1);
  assert.equal(report.routeEdgeEvaluation.stateSummary.BLOCKED, 1);
});

test("unresolved state가 하나라도 있으면 INELIGIBLE이다", () => {
  const values = input();
  values.route = { ...values.route, stateSummary: { ...values.route.stateSummary, UNKNOWN: 1 } };
  const report = deriveAccessibilityEligibility(values);
  assert.equal(report.decision, "INELIGIBLE");
  assert.deepEqual(report.blockers, ["routeEdgeEvaluation:UNKNOWN"]);
});

function cell(stationId, lineId, domain, effectiveState) {
  return { stationId, lineId, operatorId: "operator-1", domain, state: effectiveState, effectiveState };
}

// #873: 경로는 승강장(역-노선)에서 시작해 승강장에서 끝난다. station-line 게이트는 평가가 실제로 요구한 cell만 본다.
test("평가가 요구하지 않는 FACILITY UNKNOWN·EXIT MISSING은 station-line blocker가 아니다", () => {
  const values = input();
  values.station = {
    ...values.station,
    rows: [{}, {}, {}, {}, {}, {}],
    stateSummary: { VERIFIED_PRESENT: 2, VERIFIED_ABSENT: 0, NOT_APPLICABLE: 0, UNKNOWN: 2, MISSING: 2, STALE: 0 },
  };
  values.route = {
    ...values.route,
    results: [
      { materializationCells: [] },
      { materializationCells: [cell("station-a", "line-1", "TRANSFER", "VERIFIED_PRESENT"), cell("station-a", "line-2", "TRANSFER", "VERIFIED_PRESENT")] },
    ],
    stateSummary: { PASS: 2, BLOCKED: 0, NOT_APPLICABLE: 0, UNKNOWN: 0, MISSING: 0, STALE: 0, NOT_EVALUATED: 0 },
  };
  const report = deriveAccessibilityEligibility(values);
  assert.equal(report.decision, "ELIGIBLE");
  assert.deepEqual(report.blockers, []);
  // 식별 결속용 stateSummary는 materialization 전체를 그대로 담는다.
  assert.equal(report.stationLineAccessibility.stateSummary.UNKNOWN, 2);
});

test("평가가 요구한 환승 끝점 TRANSFER cell이 UNKNOWN이면 station-line blocker다", () => {
  const values = input();
  values.route = {
    ...values.route,
    eligible: false,
    results: [{ materializationCells: [cell("station-a", "line-1", "TRANSFER", "VERIFIED_PRESENT"), cell("station-a", "line-2", "TRANSFER", "UNKNOWN")] }],
    stateSummary: { PASS: 0, BLOCKED: 0, NOT_APPLICABLE: 0, UNKNOWN: 1, MISSING: 0, STALE: 0, NOT_EVALUATED: 0 },
  };
  const report = deriveAccessibilityEligibility(values);
  assert.equal(report.decision, "INELIGIBLE");
  assert.deepEqual(report.blockers, ["routeEdgeEvaluation:INELIGIBLE", "routeEdgeEvaluation:UNKNOWN", "stationLineAccessibility:UNKNOWN"]);
});

test("평가 결과에 materialization cell 목록이 없으면 명시적으로 실패한다", () => {
  const values = input();
  values.route = { ...values.route, results: [{}] };
  assert.throws(() => deriveAccessibilityEligibility(values), /materialization cells are required/);
});
