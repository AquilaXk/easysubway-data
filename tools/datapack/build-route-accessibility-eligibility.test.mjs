import assert from "node:assert/strict";
import test from "node:test";

import { deriveAccessibilityEligibility } from "./build-route-accessibility-eligibility.mjs";

const HASH = "a".repeat(64);

function input(overrides = {}) {
  return {
    final: { candidate: { candidateId: "candidate" }, gates: Object.fromEntries(["sourceFreshness", "stationLineAccessibility", "routeEdgeEvaluation", "artifactInventory"].map((key) => [key, { state: "PASS" }])) },
    station: { rows: [{}], materializationDigest: HASH, stateSummary: { VERIFIED_PRESENT: 0, VERIFIED_ABSENT: 0, NOT_APPLICABLE: 0, UNVERIFIED_EVIDENCE_BLOCKED: 1, UNKNOWN: 0, MISSING: 0, STALE: 0 } },
    route: { results: [{}], evaluationDigest: "b".repeat(64), eligible: true, stateSummary: { PASS: 0, BLOCKED: 1, NOT_APPLICABLE: 0, UNKNOWN: 0, MISSING: 0, STALE: 0, NOT_EVALUATED: 0 } },
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
