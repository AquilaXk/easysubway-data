import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import {
  assertServerRouteCoverageConsumed,
  isAuthorizedServerRouteCoverageGap,
  parseArgs,
  parseServerRouteCoverageProvenance,
  parseServerRouteCoverageEvidence,
} from "./validate-datapack.mjs";

test("server route coverage v1 authority는 exact 213/213/30 missing rows와 provenance를 한 번 소비한다", () => {
  const report = authorityReport();
  const bytes = Buffer.from(canonicalJson(report));
  assert.deepEqual(parseServerRouteCoverageEvidence(bytes), report);
  assert.throws(() => parseServerRouteCoverageEvidence(Buffer.concat([bytes, Buffer.from("\n")])), /canonical/);
  assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson({ ...report, authoritySha256: "b".repeat(64) }))), /hash/);
  const provenance = parseServerRouteCoverageProvenance(provenanceBytes(report));
  const rows = sqliteRows(report);
  const coverage = {
    entry: { denominator: 213, missingCount: 213 },
    exit: { denominator: 213, missingCount: 213 },
    transfer: { denominator: 30, missingCount: 30 },
  };
  const args = { pack: { id: "capital", version: "1", artifactKind: "production" }, report, provenance, coverage, edgeRows: rows, unverifiedAccessibilityCoverageEdges: [] };
  assert.equal(isAuthorizedServerRouteCoverageGap(args), true);
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, pack: { ...args.pack, version: "2" } }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, provenance: { ...provenance, candidateFixtureSha256: "0".repeat(64) } }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, edgeRows: rows.slice(1) }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, edgeRows: rows.map((row, index) => index === 0 ? { ...row, verification_status: "NOT_VERIFIED" } : row) }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, coverage: { ...coverage, transfer: { denominator: 30, missingCount: 29 } } }), false);

  const parsedArgs = parseArgs(["--manifest", "manifest.json", "--root", "out", "--require-production", "--server-route-coverage-evidence", "authority.json", "--server-route-coverage-provenance", "provenance.json"]);
  assert.equal(parsedArgs["server-route-coverage-evidence"], "authority.json");
  assert.throws(() => parseArgs(["--manifest", "manifest.json", "--root", "out", "--require-production", "--server-route-coverage-evidence", "authority.json"]), /evidence and provenance/);
  assert.doesNotThrow(() => assertServerRouteCoverageConsumed(null));
  assert.doesNotThrow(() => assertServerRouteCoverageConsumed({ consumptionCount: 1 }));
  assert.throws(() => assertServerRouteCoverageConsumed({ consumptionCount: 0 }), /not consumed exactly once/);
});

test("authority edge/cell/candidate/provenance drift는 canonical hash를 다시 봉인해도 거부된다", () => {
  for (const [label, mutate, pattern] of [
    ["edge denominator", (value) => { value.edges.pop(); }, /denominator|coverage/i],
    ["cell state", (value) => { value.edges[0].requiredCells[0].state = "UNKNOWN"; }, /cell|state/i],
    ["cell endpoint", (value) => { value.edges[0].requiredCells[0].lineId = "seoul-4"; }, /cell endpoint/i],
    ["route hash", (value) => { value.edges[0].routeEdgeSha256 = "0".repeat(64); }, /route edge hash/i],
    ["candidate", (value) => { value.candidate.sourceSetSha256 = "0".repeat(64); }, /candidate|binding/i],
    ["build input", (value) => { value.buildInput.candidateFixtureSha256 = "0".repeat(64); }, /binding|provenance/i],
  ]) {
    const report = authorityReport();
    mutate(report);
    reseal(report);
    if (label === "candidate" || label === "build input") {
      const parsed = parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(report)));
      assert.equal(isAuthorizedServerRouteCoverageGap({
        pack: { id: "capital", version: "1", artifactKind: "production" },
        report: parsed,
        provenance: parseServerRouteCoverageProvenance(provenanceBytes(authorityReport())),
        coverage: { entry: { denominator: 213, missingCount: 213 }, exit: { denominator: 213, missingCount: 213 }, transfer: { denominator: 30, missingCount: 30 } },
        edgeRows: sqliteRows(parsed),
        unverifiedAccessibilityCoverageEdges: [],
      }), false, label);
    } else {
      assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(report))), pattern, label);
    }
  }
});

function authorityReport() {
  const candidate = {
    candidateId: "capital-pilot-candidate-20260814",
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    sourceSetSha256: "a".repeat(64),
    stationSetSha256: "b".repeat(64),
  };
  const edges = [
    ...Array.from({ length: 213 }, (_, index) => edge("ENTRY", index)),
    ...Array.from({ length: 213 }, (_, index) => edge("EXIT", index)),
    ...Array.from({ length: 30 }, (_, index) => edge("IN_STATION_TRANSFER", index)),
  ].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const payload = {
    schemaVersion: 1,
    artifactKind: "server-route-coverage-authority",
    candidate,
    buildInput: {
      buildSpecSha256: "c".repeat(64),
      sourceFixtureSha256: "d".repeat(64),
      candidateFixtureSha256: "e".repeat(64),
      stationLineInputSha256: "f".repeat(64),
      routeEdgeInputSha256: "1".repeat(64),
      transferMetricsSha256: sha(Buffer.from("fixture-transfer-metrics")),
      materializationDigest: "2".repeat(64),
      observedAt: "2026-08-16T00:00:00.000Z",
    },
    edgeCounts: { ENTRY: 213, EXIT: 213, IN_STATION_TRANSFER: 30, total: 456 },
    edges,
  };
  return { ...payload, authoritySha256: sha(canonicalJson(payload)) };
}

function edge(edgeType, index) {
  const suffix = String(index).padStart(3, "0");
  const stationId = `station-${suffix}`;
  const transfer = edgeType === "IN_STATION_TRANSFER";
  const value = {
    edgeId: `edge-${edgeType.toLowerCase()}-${suffix}`,
    edgeType,
    fromNodeId: edgeType === "ENTRY" ? stationId : `${stationId}:seoul-2`,
    toNodeId: edgeType === "EXIT" ? stationId : transfer ? `${stationId}:seoul-4` : `${stationId}:seoul-2`,
    durationSeconds: edgeType === "ENTRY" ? 90 : edgeType === "EXIT" ? 60 : 0,
    distanceMeters: transfer ? 10 : 0,
    requiredCells: transfer
      ? [cell(stationId, "seoul-2", "TRANSFER", "VERIFIED_PRESENT"), cell(stationId, "seoul-4", "TRANSFER", "NOT_APPLICABLE")]
      : [cell(stationId, "seoul-2", edgeType === "ENTRY" ? "FACILITY" : "EXIT", index === 0 ? "UNVERIFIED_EVIDENCE_BLOCKED" : "VERIFIED_PRESENT")],
  };
  return {
    ...value,
    routeEdgeSha256: sha(canonicalJson({
      edgeId: value.edgeId,
      edgeType: value.edgeType,
      fromNodeId: value.fromNodeId,
      toNodeId: value.toNodeId,
      durationSeconds: value.durationSeconds,
      distanceMeters: value.distanceMeters,
      servicePattern: "",
      serviceClass: "SUBWAY",
    })),
  };
}

function cell(stationId, lineId, domain, state) {
  return { stationId, lineId, domain, state, rowSha256: sha(`${stationId}:${lineId}:${domain}:${state}`) };
}

function provenanceBytes(report) {
  return Buffer.from(JSON.stringify({
    candidateBuild: {
      candidateId: report.candidate.candidateId,
      sourceSnapshotSetHash: report.candidate.sourceSetSha256,
      buildSpecSha256: report.buildInput.buildSpecSha256,
      sourceFixtureSha256: report.buildInput.sourceFixtureSha256,
      candidateFixtureSha256: report.buildInput.candidateFixtureSha256,
      serverRouteCoverageAuthoritySha256: report.authoritySha256,
    },
  }));
}

function sqliteRows(report) {
  return report.edges.map((edge) => ({
    id: edge.edgeId,
    from_node_id: edge.fromNodeId,
    to_node_id: edge.toNodeId,
    edge_type: edge.edgeType,
    duration_seconds: edge.durationSeconds,
    distance_meters: edge.distanceMeters,
    verification_status: "UNKNOWN",
    stair_access_state: "UNKNOWN",
    accessibility_status: "UNKNOWN",
  }));
}

function reseal(report) {
  report.authoritySha256 = sha(canonicalJson(without(report, "authoritySha256")));
}

function without(value, key) {
  const { [key]: _ignored, ...rest } = value;
  return rest;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
