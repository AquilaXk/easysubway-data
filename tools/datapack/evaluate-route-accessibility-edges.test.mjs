import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalRideEdgeSetSha256,
  canonicalRouteEdgeEvaluationJson,
  evaluateRouteAccessibilityEdges,
  routeEdgeSha256,
} from "./evaluate-route-accessibility-edges.mjs";
import {
  canonicalStationLineAccessibilityPayloadJson,
  materializeStationLineAccessibility,
} from "./materialize-station-line-accessibility.mjs";

const NOW = "2026-08-10T00:00:00.000Z";
const HASH = "a".repeat(64);
const MATERIALIZATION_STATION_SET_SHA256 = createHash("sha256")
  .update(JSON.stringify(["station-a", "station-b", "station-c"]))
  .digest("hex");
const policy = JSON.parse(readFileSync(
  new URL("../../release/product-gates/route-edge-evaluation-policy.json", import.meta.url),
  "utf8",
));

function materializationCandidate(overrides = {}) {
  return {
    candidateId: "candidate-capital-1",
    stationSetSha256: MATERIALIZATION_STATION_SET_SHA256,
    sourceSetSha256: "2".repeat(64),
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    ...overrides,
  };
}

function evaluationCandidate(overrides = {}) {
  return {
    candidateId: "candidate-capital-1",
    stationSetSha256: "1".repeat(64),
    sourceSetSha256: "2".repeat(64),
    topologySha256: "3".repeat(64),
    policyVersion: policy.policyVersion,
    evaluatorVersion: "1",
    ...overrides,
  };
}

function stationLines() {
  return [
    { stationId: "station-a", lineId: "line-1", operatorId: "operator-1", lineSequence: 1 },
    { stationId: "station-b", lineId: "line-1", operatorId: "operator-1", lineSequence: 2 },
    { stationId: "station-a", lineId: "line-2", operatorId: "operator-2", lineSequence: 1 },
    { stationId: "station-c", lineId: "line-3", operatorId: "operator-3", lineSequence: 1 },
  ];
}

function evidence(overrides = {}) {
  return {
    candidateId: "candidate-capital-1",
    stationSetSha256: MATERIALIZATION_STATION_SET_SHA256,
    sourceSetSha256: "2".repeat(64),
    sourceId: "official-accessibility",
    sourceSnapshotId: "official-accessibility-20260809",
    stationId: "station-a",
    lineId: "line-1",
    operatorId: "operator-1",
    domain: "FACILITY",
    state: "VERIFIED_PRESENT",
    evidenceRawSha256: HASH,
    providerRecordHash: "b".repeat(64),
    capturedAt: "2026-08-09T00:00:00.000Z",
    freshUntil: "2026-08-11T00:00:00.000Z",
    provenanceId: "official-provider",
    licenseId: "public-data-license",
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    evidenceKind: "OBSERVED",
    evidenceReason: "official evidence",
    ...overrides,
  };
}

function materialization(lines = stationLines()) {
  return materializeStationLineAccessibility({
    candidate: materializationCandidate(),
    observedAt: NOW,
    stationLines: lines.map(({ lineSequence: _lineSequence, ...line }) => line),
    evidenceRows: [
      evidence(),
      evidence({ domain: "EXIT", state: "VERIFIED_ABSENT", evidenceKind: "EXPLICIT_ZERO", evidenceReason: "official zero exit" }),
      evidence({ domain: "TRANSFER", state: "NOT_APPLICABLE", evidenceKind: "CURRENT_APPLICABILITY_RULE", evidenceReason: "no interchange at this line" }),
      evidence({ stationId: "station-a", lineId: "line-2", operatorId: "operator-2", domain: "TRANSFER", state: "NOT_APPLICABLE", evidenceKind: "CURRENT_APPLICABILITY_RULE", evidenceReason: "no interchange at this line" }),
      evidence({ stationId: "station-b", domain: "FACILITY", state: "UNKNOWN", evidenceKind: "PROVIDER_NO_DATA", evidenceReason: "provider no data" }),
      evidence({ stationId: "station-b", domain: "TRANSFER" }),
      evidence({ stationId: "station-c", lineId: "line-3", operatorId: "operator-3", freshUntil: NOW }),
    ],
  });
}

function emptyMaterialization() {
  return materializeStationLineAccessibility({
    candidate: materializationCandidate({
      stationSetSha256: createHash("sha256").update("[]").digest("hex"),
    }),
    observedAt: NOW,
    stationLines: [],
    evidenceRows: [],
  });
}

function edge(value) {
  const withoutHash = {
    edgeId: value.edgeId,
    edgeType: value.edgeType,
    fromNodeId: value.fromNodeId,
    toNodeId: value.toNodeId,
    durationSeconds: value.durationSeconds ?? 0,
    distanceMeters: value.distanceMeters ?? 0,
    servicePattern: value.servicePattern ?? "",
    serviceClass: value.serviceClass ?? "SUBWAY",
  };
  return { ...withoutHash, edgeSha256: routeEdgeSha256(withoutHash) };
}

function routeEdges() {
  return [
    edge({ edgeId: "ride-a-b", edgeType: "RIDE", fromNodeId: "station-a:line-1", toNodeId: "station-b:line-1", durationSeconds: 120, distanceMeters: 1000, servicePattern: "LOCAL" }),
    edge({ edgeId: "entry-a", edgeType: "ENTRY", fromNodeId: "station-a", toNodeId: "station-a:line-1" }),
    edge({ edgeId: "exit-a", edgeType: "EXIT", fromNodeId: "station-a:line-1", toNodeId: "station-a" }),
    edge({ edgeId: "transfer-a", edgeType: "IN_STATION_TRANSFER", fromNodeId: "station-a:line-1", toNodeId: "station-a:line-2" }),
    edge({ edgeId: "entry-b", edgeType: "ENTRY", fromNodeId: "station-b", toNodeId: "station-b:line-1" }),
    edge({ edgeId: "exit-b", edgeType: "EXIT", fromNodeId: "station-b:line-1", toNodeId: "station-b" }),
    edge({ edgeId: "entry-c", edgeType: "ENTRY", fromNodeId: "station-c", toNodeId: "station-c:line-3" }),
    edge({ edgeId: "future-edge", edgeType: "FUTURE_EDGE", fromNodeId: "station-a:line-1", toNodeId: "station-b:line-1" }),
  ];
}

function input(overrides = {}) {
  return {
    candidate: evaluationCandidate(),
    evaluationAt: NOW,
    stationLines: stationLines(),
    routeEdges: routeEdges(),
    materialization: materialization(),
    ...overrides,
  };
}

function rebindMaterialization(value) {
  return {
    ...value,
    materializationDigest: createHash("sha256")
      .update(canonicalStationLineAccessibilityPayloadJson(value))
      .digest("hex"),
  };
}

function policyForEdges(edges) {
  const value = structuredClone(policy);
  value.rideInvariant.subwayLocal.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256(
    edges.filter(({ edgeType, serviceClass, servicePattern }) => edgeType === "RIDE" && serviceClass === "SUBWAY" && servicePattern === "LOCAL"),
  );
  value.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256(
    edges.filter(({ edgeType, serviceClass }) => edgeType === "RIDE" && serviceClass === "ITX_CHEONGCHUN"),
  );
  return value;
}

function terminalScenario(overrides = {}) {
  const stationId = "station-b35616704ce3"; const lineId = "seoul-2"; const operatorId = "seoul-metro";
  const stationSetSha256 = createHash("sha256").update(JSON.stringify([stationId])).digest("hex");
  const candidate = { candidateId: "candidate-capital-1", stationSetSha256, sourceSetSha256: "2".repeat(64), mappingContractVersion: "station-line-v1", materializerVersion: "1" };
  const base = { ...candidate, stationId, lineId, operatorId, sourceId: "kric-station-convenience-standard", sourceSnapshotId: "terminal-snapshot", evidenceRawSha256: HASH, capturedAt: "2026-08-09T00:00:00.000Z", freshUntil: "2026-08-11T00:00:00.000Z", provenanceId: "official-provider", licenseId: "public-data-license" };
  const terminal = { ...base, domain: "FACILITY", state: "UNVERIFIED_EVIDENCE_BLOCKED", evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED", evidenceReason: "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.", providerRecordHash: null, terminalPolicy: "EXACT_TUPLE_PROVIDER_RESULT_03", providerResultCode: "03", providerResponseSha256: "c".repeat(64), ...overrides };
  const normal = (domain) => ({ ...base, domain, state: "VERIFIED_PRESENT", evidenceKind: "OBSERVED", evidenceReason: "official evidence", providerRecordHash: "b".repeat(64) });
  const rows = [normal("EXIT"), terminal, normal("TRANSFER")].sort((a, b) => `${a.stationId}\0${a.lineId}\0${a.operatorId}\0${a.domain}`.localeCompare(`${b.stationId}\0${b.lineId}\0${b.operatorId}\0${b.domain}`));
  const summary = { VERIFIED_PRESENT: 2, VERIFIED_ABSENT: 0, NOT_APPLICABLE: 0, UNKNOWN: 0, MISSING: 0, STALE: terminal.state === "STALE" ? 1 : 0, ...(terminal.state === "UNVERIFIED_EVIDENCE_BLOCKED" ? { UNVERIFIED_EVIDENCE_BLOCKED: 1 } : {}) };
  if (terminal.state === "STALE") summary.VERIFIED_PRESENT = 2;
  const materialization = rebindMaterialization({ candidate, rows, stateSummary: summary, materializationDigest: "0".repeat(64) });
  const raw = { edgeId: "entry-terminal", edgeType: "ENTRY", fromNodeId: stationId, toNodeId: `${stationId}:${lineId}`, durationSeconds: 0, distanceMeters: 0, servicePattern: "", serviceClass: "SUBWAY" };
  const route = { ...raw, edgeSha256: routeEdgeSha256(raw) };
  const value = { candidate: { ...evaluationCandidate(), stationSetSha256 }, evaluationAt: NOW, stationLines: [{ stationId, lineId, operatorId, lineSequence: 1 }], routeEdges: [route], materialization };
  return { value, policy: policyForEdges([route]) };
}

test("모든 route edge를 한 번씩 평가하고 blocked·unresolved edge도 분모에 보존한다", () => {
  const value = input();
  const before = structuredClone(value);
  const fixturePolicy = policyForEdges(value.routeEdges);

  const first = evaluateRouteAccessibilityEdges(value, fixturePolicy);
  const second = evaluateRouteAccessibilityEdges(value, fixturePolicy);

  assert.deepEqual(value, before);
  assert.equal(first.denominator.edgeCount, value.routeEdges.length);
  assert.equal(first.results.length, value.routeEdges.length);
  assert.deepEqual(first.results.map(({ edgeId, state }) => ({ edgeId, state })), [
    { edgeId: "entry-a", state: "PASS" },
    { edgeId: "entry-b", state: "UNKNOWN" },
    { edgeId: "entry-c", state: "STALE" },
    { edgeId: "exit-a", state: "BLOCKED" },
    { edgeId: "exit-b", state: "MISSING" },
    { edgeId: "future-edge", state: "NOT_EVALUATED" },
    { edgeId: "ride-a-b", state: "PASS" },
    { edgeId: "transfer-a", state: "NOT_APPLICABLE" },
  ]);
  assert.deepEqual(first.stateSummary, {
    PASS: 2,
    BLOCKED: 1,
    NOT_APPLICABLE: 1,
    UNKNOWN: 1,
    MISSING: 1,
    STALE: 1,
    NOT_EVALUATED: 1,
  });
  assert.equal(first.eligible, false);
  assert.match(first.denominator.digest, /^[a-f0-9]{64}$/);
  assert.match(first.evaluationDigest, /^[a-f0-9]{64}$/);
  assert.equal(canonicalRouteEdgeEvaluationJson(first), canonicalRouteEdgeEvaluationJson(second));
  assert.equal(first.evaluationDigest, second.evaluationDigest);
  assert.equal(first.results.find(({ edgeId }) => edgeId === "exit-a").materializationCells[0].state, "VERIFIED_ABSENT");
  assert.equal(first.results.find(({ edgeId }) => edgeId === "ride-a-b").materializationCells.length, 0);
});

test("exact terminal FACILITY cell은 availability claim 없이 dependent edge를 BLOCKED로 만든다", () => {
  const { value, policy: fixturePolicy } = terminalScenario();
  const result = evaluateRouteAccessibilityEdges(value, fixturePolicy);

  const edgeResult = result.results.find(({ edgeId }) => edgeId === "entry-terminal");
  assert.equal(edgeResult.state, "BLOCKED");
  assert.equal(edgeResult.reason, "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.");
  assert.equal(edgeResult.materializationCells[0].providerRecordHash, null);
  assert.equal(edgeResult.materializationCells[0].providerResponseSha256, "c".repeat(64));
  for (const [field, value] of [["domain", "EXIT"], ["stationId", "wrong-station"], ["sourceId", "wrong-source"]]) {
    const { value: invalid, policy } = terminalScenario({ [field]: value });
    if (field === "stationId") {
      invalid.stationLines[0].stationId = value;
      invalid.routeEdges[0] = { ...invalid.routeEdges[0], fromNodeId: value, toNodeId: `${value}:seoul-2` };
      const { edgeSha256: _edgeSha256, ...raw } = invalid.routeEdges[0];
      invalid.routeEdges[0].edgeSha256 = routeEdgeSha256(raw);
      const stationSetSha256 = createHash("sha256").update(JSON.stringify([value])).digest("hex");
      invalid.materialization.candidate.stationSetSha256 = stationSetSha256;
      invalid.materialization.rows = invalid.materialization.rows.map((row) => ({ ...row, stationId: value, stationSetSha256 }));
      invalid.materialization = rebindMaterialization(invalid.materialization);
    }
    assert.throws(() => evaluateRouteAccessibilityEdges(invalid, policy), /terminal materialization contract mismatch/);
  }
});

test("stale terminal carrier는 schema-valid unresolved STALE로 남는다", () => {
  const { value, policy: fixturePolicy } = terminalScenario({ state: "STALE", freshUntil: NOW });
  const result = evaluateRouteAccessibilityEdges(value, fixturePolicy);

  assert.equal(result.results.find(({ edgeId }) => edgeId === "entry-terminal").state, "STALE");
  assert.equal(result.stateSummary.STALE, 1);
  assert.equal(result.eligible, false);
});

test("SUBWAY LOCAL과 policy-bound ITX EXPRESS RIDE invariant를 exact하게 강제한다", () => {
  const local = routeEdges().find(({ edgeId }) => edgeId === "ride-a-b");
  const localPolicy = policyForEdges([local]);
  assert.equal(evaluateRouteAccessibilityEdges(input({ routeEdges: [local], materialization: emptyMaterialization() }), localPolicy).results[0].state, "PASS");
  assert.throws(
    () => evaluateRouteAccessibilityEdges(input({ routeEdges: [local] }), policy),
    /SUBWAY LOCAL edge set identity mismatch/,
  );

  const nonAdjacent = edge({ edgeId: "ride-a-c", edgeType: "RIDE", fromNodeId: "station-a:line-1", toNodeId: "station-c:line-3", durationSeconds: 120, distanceMeters: 1000, servicePattern: "LOCAL" });
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges: [nonAdjacent] }), localPolicy), /SUBWAY LOCAL edge set identity mismatch/);
  const tooFast = edge({ edgeId: "ride-fast", edgeType: "RIDE", fromNodeId: "station-a:line-1", toNodeId: "station-b:line-1", durationSeconds: 1, distanceMeters: 1000, servicePattern: "LOCAL" });
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges: [tooFast], materialization: emptyMaterialization() }), policyForEdges([tooFast])), /RIDE speed is outside policy bounds/);

  const itxEdges = [
    edge({ edgeId: "itx-1", edgeType: "RIDE", fromNodeId: "station-a:line-1:EXPRESS", toNodeId: "station-b:line-1:EXPRESS", durationSeconds: 120, distanceMeters: 1000, servicePattern: "EXPRESS", serviceClass: "ITX_CHEONGCHUN" }),
  ];
  const fixturePolicy = policyForEdges(itxEdges);
  assert.equal(evaluateRouteAccessibilityEdges(input({ routeEdges: itxEdges, materialization: emptyMaterialization() }), fixturePolicy).results[0].state, "PASS");
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges: [edge({ ...itxEdges[0], edgeId: "itx-tampered" })] }), fixturePolicy), /ITX EXPRESS edge set identity mismatch/);
  assert.equal(policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256, "894c37b5cbc62aa8ac296821fab07da537f41802dc5fbe2a806a4a37ccc19f36");

  const crossStationTransfer = edge({
    edgeId: "transfer-cross-station",
    edgeType: "IN_STATION_TRANSFER",
    fromNodeId: "station-a:line-1",
    toNodeId: "station-b:line-1",
  });
  assert.throws(
    () => evaluateRouteAccessibilityEdges(
      input({ routeEdges: [crossStationTransfer] }),
      policyForEdges([crossStationTransfer]),
    ),
    /IN_STATION_TRANSFER station identity mismatch/,
  );
});

test("tracked capital topology의 current ITX RIDE edge set이 policy digest와 exact하게 결속된다", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("./release/capital-production-canonical-pack.json", import.meta.url),
    "utf8",
  ));
  const capital = fixture.packs.find(({ id }) => id === "capital");
  const itxEdges = capital.networkEdges
    .filter(({ edgeType, serviceClass }) => edgeType === "RIDE" && serviceClass === "ITX_CHEONGCHUN")
    .map((row) => ({
      edgeId: row.id,
      edgeType: row.edgeType,
      fromNodeId: row.fromNodeId,
      toNodeId: row.toNodeId,
      durationSeconds: row.durationSeconds,
      distanceMeters: row.distanceMeters,
      servicePattern: row.servicePattern,
      serviceClass: row.serviceClass,
    }));
  assert.ok(itxEdges.length > 0);
  assert.equal(
    canonicalRideEdgeSetSha256(itxEdges),
    policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256,
  );
});

test("identity·closed schema·digest·endpoint·denominator 오류를 fail closed한다", () => {
  const unitPolicy = policyForEdges(routeEdges());
  const duplicate = routeEdges()[0];
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges: [duplicate, duplicate] }), unitPolicy), /duplicate route edge/);
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    routeEdges: [edge({ edgeId: "unmapped", edgeType: "RIDE", fromNodeId: "station-z:line-1", toNodeId: "station-b:line-1", servicePattern: "LOCAL" })],
  }), unitPolicy), /unmapped route edge endpoint/);
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    routeEdges: [edge({ edgeId: "ambiguous-suffix", edgeType: "RIDE", fromNodeId: "station-a:line-1:LOCAL", toNodeId: "station-b:line-1", servicePattern: "LOCAL" })],
  }), unitPolicy), /route edge endpoint suffix is invalid/);
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    routeEdges: [edge({ edgeId: "unmapped-station", edgeType: "FUTURE_EDGE", fromNodeId: "station-z", toNodeId: "station-b:line-1" })],
  }), unitPolicy), /unmapped route edge endpoint/);
  assert.doesNotThrow(() => evaluateRouteAccessibilityEdges(input({
    candidate: evaluationCandidate({ stationSetSha256: "9".repeat(64) }),
  }), unitPolicy));
  const scopedDrift = materialization();
  scopedDrift.candidate.stationSetSha256 = "9".repeat(64);
  scopedDrift.rows = scopedDrift.rows.map((row) => ({ ...row, stationSetSha256: "9".repeat(64) }));
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    materialization: rebindMaterialization(scopedDrift),
  }), unitPolicy), /materialization scoped station set identity mismatch/);
  const missingCell = materialization();
  const removed = missingCell.rows.pop();
  missingCell.stateSummary[removed.state] -= 1;
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    materialization: rebindMaterialization(missingCell),
  }), unitPolicy), /materialization policy target denominator mismatch/);
  const extraLine = { stationId: "station-d", lineId: "line-4", operatorId: "operator-4", lineSequence: 1 };
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    stationLines: [...stationLines(), extraLine],
    materialization: materialization([...stationLines(), extraLine]),
  }), unitPolicy), /materialization policy target denominator mismatch/);
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    routeEdges: [{ ...routeEdges()[0], edgeSha256: "0".repeat(64) }],
  }), unitPolicy), /route edge sha256 mismatch/);
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ evaluationAt: "2026-08-10" }), unitPolicy), /evaluationAt/);
  assert.throws(() => evaluateRouteAccessibilityEdges({ ...input(), extra: true }, unitPolicy), /input keys mismatch/);
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    materialization: { ...materialization(), materializationDigest: "0".repeat(64) },
  }), unitPolicy), /materialization digest mismatch/);
  const reordered = materialization();
  reordered.rows.reverse();
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    materialization: rebindMaterialization(reordered),
  }), unitPolicy), /materialization row order is not canonical/);
  const forged = materialization();
  const forgedRow = forged.rows.find(({ state }) => state === "VERIFIED_PRESENT");
  forgedRow.evidenceKind = "EXPLICIT_ZERO";
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    materialization: rebindMaterialization(forged),
  }), unitPolicy), /materialization evidence kind mismatch/);
  const future = materialization();
  const futureRow = future.rows.find(({ state }) => state === "NOT_APPLICABLE");
  futureRow.capturedAt = "2026-08-10T00:00:00.001Z";
  futureRow.freshUntil = "2026-08-11T00:00:00.000Z";
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    materialization: rebindMaterialization(future),
  }), unitPolicy), /materialization capturedAt is after evaluationAt/);
  assert.throws(() => evaluateRouteAccessibilityEdges(input(), { ...unitPolicy, unexpected: true }), /policy keys mismatch/);
});
