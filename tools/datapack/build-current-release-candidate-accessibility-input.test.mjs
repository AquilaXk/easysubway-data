import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { canonicalStationLineAccessibilityPayloadJson } from "./materialize-station-line-accessibility.mjs";
import { routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";
import { buildCurrentReleaseCandidateAccessibilityAuthority } from "./build-current-release-candidate-accessibility-input.mjs";

const candidate = { candidateId: "capital-pilot-candidate-20260814", stationSetSha256: "c".repeat(64), sourceSetSha256: "a".repeat(64), mappingContractVersion: "station-line-v1", materializerVersion: "1" };
const baseEdge = (edgeId, edgeType, fromNodeId, toNodeId) => { const edge = { edgeId, edgeType, fromNodeId, toNodeId, durationSeconds: 0, distanceMeters: 0, servicePattern: "", serviceClass: "SUBWAY" }; return { ...edge, edgeSha256: routeEdgeSha256(edge) }; };
function fixture() {
  const edges = [baseEdge("entry-1", "ENTRY", "s1", "s1:l1"), baseEdge("entry-2", "ENTRY", "s2", "s2:l1"), baseEdge("exit-1", "EXIT", "s1:l1", "s1"), baseEdge("exit-2", "EXIT", "s2:l1", "s2")];
  const rows = ["s1", "s2"].flatMap((stationId) => ["FACILITY", "EXIT", "TRANSFER"].map((domain) => ({ ...candidate, stationId, lineId: "l1", operatorId: "op", domain, state: "VERIFIED_PRESENT", sourceId: "source", sourceSnapshotId: "snapshot", evidenceRawSha256: "d".repeat(64), providerRecordHash: "e".repeat(64), capturedAt: "2026-08-14T00:00:00.000Z", freshUntil: "2026-08-15T00:00:00.000Z", provenanceId: "provenance", licenseId: "license", evidenceKind: "OBSERVED", evidenceReason: "reason" })));
  const stateSummary = { VERIFIED_PRESENT: 6, VERIFIED_ABSENT: 0, NOT_APPLICABLE: 0, UNKNOWN: 0, MISSING: 0, STALE: 0 };
  const materialization = { candidate, rows, stateSummary, materializationDigest: "" };
  materialization.materializationDigest = sha256(canonicalStationLineAccessibilityPayloadJson(materialization));
  const route = {
    candidate: { candidateId: candidate.candidateId, stationSetSha256: candidate.stationSetSha256, sourceSetSha256: candidate.sourceSetSha256, policyVersion: "route-edge-evaluation-v2", evaluatorVersion: "1" },
    stationLines: [
      { stationId: "s1", lineId: "l1", operatorId: "op", lineSequence: 1 },
      { stationId: "s2", lineId: "l1", operatorId: "op", lineSequence: 2 },
    ],
    routeEdges: edges,
  };
  const pack = { networkEdges: edges.map((edge) => ({ id: edge.edgeId, ...edge, verificationStatus: "NOT_VERIFIED", stairAccessState: "UNKNOWN", accessibilityStatus: "UNKNOWN" })) };
  return { buildSpec: { candidateId: candidate.candidateId, sourceSnapshotSetHash: candidate.sourceSetSha256 }, materialization, route, pack };
}

test("current #8/#9 terminal evidence는 closed materialization과 hashed seed를 요구한다", () => {
  const value = fixture();
  const report = buildCurrentReleaseCandidateAccessibilityAuthority({ canonicalPack: value.pack, ...value });
  assert.equal(report.edges.length, 4);
  const cases = [
    ["mixed row", (x) => { x.materialization.rows[0].sourceSetSha256 = "f".repeat(64); }, /identity/],
    ["digest", (x) => { x.materialization.materializationDigest = "f".repeat(64); }, /digest/],
    ["edge hash", (x) => { x.route.routeEdges[0].edgeSha256 = "f".repeat(64); }, /hash/],
    ["extra non ride", (x) => { x.route.routeEdges.push(baseEdge("extra", "WALKWAY", "s1", "s2")); }, /coverage/],
  ];
  for (const [, mutate, pattern] of cases) { const changed = structuredClone(value); mutate(changed); assert.throws(() => buildCurrentReleaseCandidateAccessibilityAuthority({ canonicalPack: changed.pack, ...changed }), pattern); }
  assert.deepEqual(JSON.parse(canonicalJson(value.pack)), value.pack);
});
