import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import {
  assertServerRouteCoverageConsumed,
  isAuthorizedServerRouteCoverageGap,
  parseArgs,
  parseServerRouteCoverageProvenance,
  parseServerRouteCoverageEvidence,
} from "./validate-datapack.mjs";

function authorityReport() {
  const candidate = {
    candidateId: "capital-pilot-candidate-20260814",
    sourceSetSha256: "a".repeat(64),
  };
  const edges = ["entry-1", "entry-2", "exit-1", "exit-2"].map((edgeId, index) => ({
    edgeId,
    fromNodeId: index < 2 ? `s${index + 1}` : `s${index - 1}:l1`,
    toNodeId: index < 2 ? `s${index + 1}:l1` : `s${index - 1}`,
    edgeType: index < 2 ? "ENTRY" : "EXIT",
    durationSeconds: 0,
    distanceMeters: 0,
    domain: index < 2 ? "FACILITY" : "EXIT",
  }));
  const payload = { schemaVersion: 1, artifactKind: "server-route-coverage-authority", candidate, edges };
  return { ...payload, authoritySha256: sha256(Buffer.from(canonicalJson(payload))) };
}

test("server route coverage authority is closed, canonical, and only consumes the exact capital 2/2 gaps", () => {
  const report = authorityReport();
  const bytes = Buffer.from(canonicalJson(report));
  assert.deepEqual(parseServerRouteCoverageEvidence(bytes), report);
  assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(JSON.stringify(report))), /canonical/);
  assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson({ ...report, authoritySha256: "b".repeat(64) }))), /hash/);
  const provenance = parseServerRouteCoverageProvenance(Buffer.from(JSON.stringify({ candidateBuild: { candidateId: report.candidate.candidateId, sourceSnapshotSetHash: report.candidate.sourceSetSha256 } })));

  const rows = report.edges.map((edge) => ({
    id: edge.edgeId,
    from_node_id: edge.fromNodeId,
    to_node_id: edge.toNodeId,
    edge_type: edge.edgeType,
    duration_seconds: edge.durationSeconds,
    distance_meters: edge.distanceMeters,
    verification_status: "NOT_VERIFIED",
    stair_access_state: "UNKNOWN",
    accessibility_status: "UNKNOWN",
  }));
  const coverage = {
    entry: { denominator: 2, missingCount: 2 },
    exit: { denominator: 2, missingCount: 2 },
    transfer: { denominator: 0, missingCount: 0 },
  };
  assert.equal(isAuthorizedServerRouteCoverageGap({ pack: { id: "capital", version: "1", artifactKind: "production" }, report, provenance, coverage, edgeRows: rows, unverifiedAccessibilityCoverageEdges: [] }), true);
  assert.equal(isAuthorizedServerRouteCoverageGap({ pack: { id: "capital", version: "2", artifactKind: "production" }, report, provenance, coverage, edgeRows: rows, unverifiedAccessibilityCoverageEdges: [] }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({ pack: { id: "capital", version: "1", artifactKind: "production" }, report, provenance: { ...provenance, candidateId: "other" }, coverage, edgeRows: rows, unverifiedAccessibilityCoverageEdges: [] }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({ pack: { id: "capital", version: "1", artifactKind: "production" }, report, provenance, coverage, edgeRows: rows, unverifiedAccessibilityCoverageEdges: ["unauthorized-step-free-gap"] }), false);

  const args = parseArgs(["--manifest", "manifest.json", "--root", "out", "--require-production", "--server-route-coverage-evidence", "authority.json", "--server-route-coverage-provenance", "provenance.json"]);
  assert.equal(args["server-route-coverage-evidence"], "authority.json");
  assert.throws(() => parseArgs(["--manifest", "manifest.json", "--root", "out", "--require-production", "--server-route-coverage-evidence", "authority.json"]), /evidence and provenance/);
  assert.doesNotThrow(() => assertServerRouteCoverageConsumed(null));
  assert.doesNotThrow(() => assertServerRouteCoverageConsumed({ consumptionCount: 1 }));
  assert.throws(() => assertServerRouteCoverageConsumed({ consumptionCount: 0 }), /not consumed exactly once/);
});
