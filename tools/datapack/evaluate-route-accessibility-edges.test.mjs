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
      evidence({ stationId: "station-a", lineId: "line-2", operatorId: "operator-2", domain: "FACILITY", state: "VERIFIED_ABSENT", evidenceKind: "EXPLICIT_ZERO", evidenceReason: "official zero facility" }),
      evidence({ stationId: "station-a", lineId: "line-2", operatorId: "operator-2", domain: "TRANSFER", state: "NOT_APPLICABLE", evidenceKind: "CURRENT_APPLICABILITY_RULE", evidenceReason: "no interchange at this line" }),
      evidence({ stationId: "station-b", domain: "FACILITY", state: "UNKNOWN", evidenceKind: "PROVIDER_NO_DATA", evidenceReason: "provider no data" }),
      evidence({ stationId: "station-b", domain: "TRANSFER" }),
      evidence({ stationId: "station-c", lineId: "line-3", operatorId: "operator-3", freshUntil: NOW }),
    ],
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

// #866 PR-C: 역 단위 ENTRY/EXIT 매핑을 지웠다. 같은 상태 분포를 FACILITY를 요구하는 WALKWAY(역-노선 양끝)와
// TRANSFER를 요구하는 환승 간선으로 만든다.
function routeEdges() {
  return [
    edge({ edgeId: "ride-a-b", edgeType: "RIDE", fromNodeId: "station-a:line-1", toNodeId: "station-b:line-1", durationSeconds: 120, distanceMeters: 1000, servicePattern: "LOCAL" }),
    edge({ edgeId: "walkway-a1", edgeType: "WALKWAY", fromNodeId: "station-a:line-1", toNodeId: "station-a:line-1" }),
    edge({ edgeId: "walkway-a2", edgeType: "WALKWAY", fromNodeId: "station-a:line-2", toNodeId: "station-a:line-2" }),
    edge({ edgeId: "transfer-a", edgeType: "IN_STATION_TRANSFER", fromNodeId: "station-a:line-1", toNodeId: "station-a:line-2" }),
    edge({ edgeId: "walkway-b1", edgeType: "WALKWAY", fromNodeId: "station-b:line-1", toNodeId: "station-b:line-1" }),
    edge({ edgeId: "out-b1-c3", edgeType: "OUT_OF_STATION_TRANSFER", fromNodeId: "station-b:line-1", toNodeId: "station-c:line-3" }),
    edge({ edgeId: "walkway-c3", edgeType: "WALKWAY", fromNodeId: "station-c:line-3", toNodeId: "station-c:line-3" }),
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
  // #866 PR-C: FACILITY를 요구하는 간선은 역-노선 양끝 WALKWAY다(ENTRY 매핑 삭제).
  const raw = { edgeId: "walkway-terminal", edgeType: "WALKWAY", fromNodeId: `${stationId}:${lineId}`, toNodeId: `${stationId}:${lineId}`, durationSeconds: 0, distanceMeters: 0, servicePattern: "", serviceClass: "SUBWAY" };
  const route = { ...raw, edgeSha256: routeEdgeSha256(raw) };
  const value = { candidate: { ...evaluationCandidate(), stationSetSha256 }, evaluationAt: NOW, stationLines: [{ stationId, lineId, operatorId, lineSequence: 1 }], routeEdges: [route], materialization };
  return { value, policy: policyForEdges([route]) };
}

function exitTerminalScenario() {
  const stationId = "station-exit"; const lineId = "line-exit"; const operatorId = "operator-exit";
  const stationSetSha256 = createHash("sha256").update(JSON.stringify([stationId])).digest("hex");
  const candidate = { candidateId: "candidate-capital-1", stationSetSha256, sourceSetSha256: "2".repeat(64), mappingContractVersion: "station-line-v1", materializerVersion: "1" };
  const base = { ...candidate, stationId, lineId, operatorId, evidenceRawSha256: HASH, capturedAt: "2026-08-09T00:00:00.000Z", freshUntil: "2026-08-11T00:00:00.000Z", provenanceId: "official-provider", licenseId: "public-data-license" };
  const responseSha256 = "9".repeat(64);
  const terminalHash = createHash("sha256").update(JSON.stringify({ domain: "EXIT", lineId, operatorId, providerResponseSha256: responseSha256, sourceSnapshotId: "kric-exit-path-20260816", stationId, terminalPolicy: "PROVIDER_NO_DATA_RESULT_03_BLOCKED" })).digest("hex");
  const terminal = { ...base, domain: "EXIT", state: "UNVERIFIED_EVIDENCE_BLOCKED", sourceId: "kric-station-movement-standard", sourceSnapshotId: "kric-exit-path-20260816", providerRecordHash: null, evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED", evidenceReason: "출구 이동경로가 검증되지 않아 경로를 차단했습니다.", terminalPolicy: "PROVIDER_NO_DATA_RESULT_03_BLOCKED", providerResultCode: "03", strictRouteEligible: false, strictRouteEligibleReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED", statusMeaning: "PROVIDER_NO_DATA_NOT_ABSENCE", confidence: 0, providerResponseSha256: responseSha256, evidenceHash: terminalHash };
  const normal = (domain) => ({ ...base, domain, state: "VERIFIED_PRESENT", sourceId: "official-accessibility", sourceSnapshotId: "official-accessibility-20260809", providerRecordHash: "b".repeat(64), evidenceKind: "OBSERVED", evidenceReason: "official evidence" });
  const materialization = materializeStationLineAccessibility({ candidate, observedAt: NOW, stationLines: [{ stationId, lineId, operatorId }], evidenceRows: [normal("FACILITY"), terminal, normal("TRANSFER")] });
  // #866 PR-C: EXIT domain을 요구하는 간선은 없다. FACILITY를 요구하는 WALKWAY 하나로 materialization 계약만 검사한다.
  const raw = { edgeId: "walkway-exit-station", edgeType: "WALKWAY", fromNodeId: `${stationId}:${lineId}`, toNodeId: `${stationId}:${lineId}`, durationSeconds: 0, distanceMeters: 0, servicePattern: "", serviceClass: "SUBWAY" };
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
    { edgeId: "future-edge", state: "NOT_EVALUATED" },
    { edgeId: "out-b1-c3", state: "MISSING" },
    { edgeId: "ride-a-b", state: "PASS" },
    { edgeId: "transfer-a", state: "NOT_APPLICABLE" },
    { edgeId: "walkway-a1", state: "PASS" },
    { edgeId: "walkway-a2", state: "BLOCKED" },
    { edgeId: "walkway-b1", state: "UNKNOWN" },
    { edgeId: "walkway-c3", state: "STALE" },
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
  // anti-cheat-allow: circular-oracle -- 무관한 필드 변경 또는 비변경 상황에서 기존 식별자/바이트 불변성(invariance) 검증
  assert.equal(canonicalRouteEdgeEvaluationJson(first), canonicalRouteEdgeEvaluationJson(second));
  // anti-cheat-allow: circular-oracle -- 무관한 필드 변경 또는 비변경 상황에서 기존 식별자/바이트 불변성(invariance) 검증
  assert.equal(first.evaluationDigest, second.evaluationDigest);
  assert.equal(first.results.find(({ edgeId }) => edgeId === "walkway-a2").materializationCells[0].state, "VERIFIED_ABSENT");
  assert.equal(first.results.find(({ edgeId }) => edgeId === "ride-a-b").materializationCells.length, 0);
});

// #873: 경로는 승강장(역-노선)에서 시작해 승강장에서 끝난다. ENTRY/EXIT 간선이 없으면 FACILITY·EXIT cell은
// 어떤 간선도 요구하지 않는다. materialization 분모·station set은 route stationLines 전체와 정확히 같아야 한다(리뷰 F3).
function platformRouteEdges() {
  return [
    edge({ edgeId: "ride-a-b", edgeType: "RIDE", fromNodeId: "station-a:line-1", toNodeId: "station-b:line-1", durationSeconds: 120, distanceMeters: 1000, servicePattern: "LOCAL" }),
    edge({ edgeId: "transfer-a", edgeType: "IN_STATION_TRANSFER", fromNodeId: "station-a:line-1", toNodeId: "station-a:line-2", durationSeconds: 90, distanceMeters: 100 }),
  ];
}

test("승강장 기준 입력은 FACILITY UNKNOWN·STALE과 EXIT MISSING이 있어도 환승 끝점 TRANSFER만 닫히면 eligible이다", () => {
  const routeEdges = platformRouteEdges();
  const value = input({ routeEdges });
  // 환승이 쓰지 않는 cell은 닫혀 있지 않다(FACILITY UNKNOWN·STALE, EXIT MISSING).
  assert.ok(value.materialization.stateSummary.UNKNOWN > 0);
  assert.ok(value.materialization.stateSummary.MISSING > 0);
  assert.ok(value.materialization.stateSummary.STALE > 0);
  const result = evaluateRouteAccessibilityEdges(value, policyForEdges(routeEdges));
  assert.equal(result.eligible, true);
  assert.deepEqual(result.results.map(({ edgeId, state }) => ({ edgeId, state })), [
    { edgeId: "ride-a-b", state: "PASS" },
    { edgeId: "transfer-a", state: "NOT_APPLICABLE" },
  ]);
  assert.deepEqual(
    result.results.flatMap(({ materializationCells }) => materializationCells.map(({ stationId, lineId, domain }) => `${stationId}:${lineId}:${domain}`)),
    ["station-a:line-1:TRANSFER", "station-a:line-2:TRANSFER"],
  );
});

test("승강장 기준 입력도 환승 끝점 TRANSFER cell이 UNKNOWN이면 ineligible이다", () => {
  const routeEdges = platformRouteEdges();
  const lines = stationLines();
  const unresolved = materializeStationLineAccessibility({
    candidate: materializationCandidate(),
    observedAt: NOW,
    stationLines: lines.map(({ lineSequence: _lineSequence, ...line }) => line),
    evidenceRows: [
      evidence({ domain: "TRANSFER" }),
      evidence({ stationId: "station-a", lineId: "line-2", operatorId: "operator-2", domain: "TRANSFER", state: "UNKNOWN", evidenceKind: "PROVIDER_NO_DATA", evidenceReason: "provider no data" }),
    ],
  });
  const result = evaluateRouteAccessibilityEdges(input({ routeEdges, materialization: unresolved }), policyForEdges(routeEdges));
  assert.equal(result.eligible, false);
  assert.equal(result.results.find(({ edgeId }) => edgeId === "transfer-a").state, "UNKNOWN");
  assert.equal(result.stateSummary.UNKNOWN, 1);
});

test("#873 F3 승강장 기준 입력의 materialization은 route stationLines와 station set·분모가 정확히 같아야 한다", () => {
  const routeEdges = platformRouteEdges();
  const fixturePolicy = policyForEdges(routeEdges);
  assert.doesNotThrow(() => evaluateRouteAccessibilityEdges(input({ routeEdges }), fixturePolicy));
  // station set 결속: materialization 식별 해시가 route stationLines의 역 집합과 다르면 실패한다(자기 행 기준으로는 맞아도).
  const extraLine = { stationId: "station-d", lineId: "line-4", operatorId: "operator-4", lineSequence: 1 };
  const drifted = materialization();
  const driftedHash = createHash("sha256").update(JSON.stringify(["station-a", "station-b", "station-c", "station-d"])).digest("hex");
  drifted.candidate.stationSetSha256 = driftedHash;
  drifted.rows = drifted.rows.map((row) => ({ ...row, stationSetSha256: driftedHash }));
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    routeEdges, materialization: rebindMaterialization(drifted),
  }), fixturePolicy), /materialization scoped station set identity mismatch/);
  // 분모·식별 결속: station-c:line-3을 뺀 materialization을 자기 행과 일관된 station set 해시로 만들면, 자기 행 기준
  // 검사로는 통과하지만 route stationLines(a·b·c)와 어긋나므로 실패해야 한다. 간선은 station-c를 요구하지 않는다.
  const partialHash = createHash("sha256").update(JSON.stringify(["station-a", "station-b"])).digest("hex");
  const partial = materializeStationLineAccessibility({
    candidate: materializationCandidate({ stationSetSha256: partialHash }),
    observedAt: NOW,
    stationLines: stationLines()
      .filter(({ stationId }) => stationId !== "station-c")
      .map(({ lineSequence: _lineSequence, ...line }) => line),
    evidenceRows: [
      evidence({ stationSetSha256: partialHash, domain: "TRANSFER" }),
      evidence({ stationSetSha256: partialHash, stationId: "station-a", lineId: "line-2", operatorId: "operator-2", domain: "TRANSFER" }),
    ],
  });
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges, materialization: partial }), fixturePolicy),
    /materialization policy target denominator mismatch/);
  // route에 없는 station-line을 materialization에 더해도 실패한다.
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    routeEdges, materialization: materialization([...stationLines(), extraLine]),
  }), fixturePolicy), /unmapped materialization row/);
});

test("exact terminal FACILITY cell은 availability claim 없이 dependent edge를 BLOCKED로 만든다", () => {
  const { value, policy: fixturePolicy } = terminalScenario();
  const result = evaluateRouteAccessibilityEdges(value, fixturePolicy);

  const edgeResult = result.results.find(({ edgeId }) => edgeId === "walkway-terminal");
  assert.equal(edgeResult.state, "BLOCKED");
  assert.equal(edgeResult.reason, "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.");
  assert.equal(edgeResult.materializationCells[0].providerRecordHash, null);
  assert.equal(edgeResult.materializationCells[0].providerResponseSha256, "c".repeat(64));
  for (const [field, value] of [["domain", "EXIT"], ["stationId", "wrong-station"], ["sourceId", "wrong-source"]]) {
    const { value: invalid, policy } = terminalScenario({ [field]: value });
    if (field === "stationId") {
      invalid.stationLines[0].stationId = value;
      invalid.routeEdges[0] = { ...invalid.routeEdges[0], fromNodeId: `${value}:seoul-2`, toNodeId: `${value}:seoul-2` };
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

// #866 PR-C·#873: 어떤 경로 간선도 EXIT domain을 요구하지 않는다(ENTRY/EXIT 매핑 삭제). provider no-data EXIT terminal cell은
// 경로를 막지 않지만 materialization 계약(domain·source·결과 코드)은 계속 fail closed로 검사한다.
test("provider no-data EXIT terminal cell은 경로 간선을 막지 않지만 terminal 계약은 계속 검사한다", () => {
  const { value, policy: fixturePolicy } = exitTerminalScenario();
  const result = evaluateRouteAccessibilityEdges(value, fixturePolicy);

  const edgeResult = result.results.find(({ edgeId }) => edgeId === "walkway-exit-station");
  assert.equal(edgeResult.state, "PASS");
  assert.deepEqual(edgeResult.materializationCells.map(({ domain }) => domain), ["FACILITY"]);
  assert.equal(result.eligible, true);

  for (const [field, changed] of [["domain", "TRANSFER"], ["sourceId", "wrong-source"], ["providerResultCode", "00"]]) {
    const { value: invalid, policy } = exitTerminalScenario();
    const row = invalid.materialization.rows.find(({ evidenceKind }) => evidenceKind === "UNVERIFIED_EVIDENCE_BLOCKED");
    row[field] = changed;
    invalid.materialization.rows.sort((left, right) => `${left.stationId}\0${left.lineId}\0${left.operatorId}\0${left.domain}`.localeCompare(`${right.stationId}\0${right.lineId}\0${right.operatorId}\0${right.domain}`));
    invalid.materialization = rebindMaterialization(invalid.materialization);
    assert.throws(() => evaluateRouteAccessibilityEdges(invalid, policy), /terminal materialization contract mismatch/);
  }
});

test("stale terminal carrier는 schema-valid unresolved STALE로 남는다", () => {
  const { value, policy: fixturePolicy } = terminalScenario({ state: "STALE", freshUntil: NOW });
  const result = evaluateRouteAccessibilityEdges(value, fixturePolicy);

  assert.equal(result.results.find(({ edgeId }) => edgeId === "walkway-terminal").state, "STALE");
  assert.equal(result.stateSummary.STALE, 1);
  assert.equal(result.eligible, false);
});

test("SUBWAY LOCAL과 policy-bound ITX EXPRESS RIDE invariant를 exact하게 강제한다", () => {
  // #873 F3: ENTRY/EXIT 없는 입력은 route stationLines 전체가 materialization돼야 하므로 기본 materialization을 쓴다.
  const local = routeEdges().find(({ edgeId }) => edgeId === "ride-a-b");
  const localPolicy = policyForEdges([local]);
  assert.equal(evaluateRouteAccessibilityEdges(input({ routeEdges: [local] }), localPolicy).results[0].state, "PASS");
  assert.throws(
    () => evaluateRouteAccessibilityEdges(input({ routeEdges: [local] }), policy),
    /SUBWAY LOCAL edge set identity mismatch/,
  );

  const nonAdjacent = edge({ edgeId: "ride-a-c", edgeType: "RIDE", fromNodeId: "station-a:line-1", toNodeId: "station-c:line-3", durationSeconds: 120, distanceMeters: 1000, servicePattern: "LOCAL" });
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges: [nonAdjacent] }), localPolicy), /SUBWAY LOCAL edge set identity mismatch/);
  const tooFast = edge({ edgeId: "ride-fast", edgeType: "RIDE", fromNodeId: "station-a:line-1", toNodeId: "station-b:line-1", durationSeconds: 1, distanceMeters: 1000, servicePattern: "LOCAL" });
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges: [tooFast] }), policyForEdges([tooFast])), /RIDE speed is outside policy bounds/);

  const itxEdges = [
    edge({ edgeId: "itx-1", edgeType: "RIDE", fromNodeId: "station-a:line-1:EXPRESS", toNodeId: "station-b:line-1:EXPRESS", durationSeconds: 120, distanceMeters: 1000, servicePattern: "EXPRESS", serviceClass: "ITX_CHEONGCHUN" }),
  ];
  const fixturePolicy = policyForEdges(itxEdges);
  assert.equal(evaluateRouteAccessibilityEdges(input({ routeEdges: itxEdges }), fixturePolicy).results[0].state, "PASS");
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges: [edge({ ...itxEdges[0], edgeId: "itx-tampered" })] }), fixturePolicy), /ITX EXPRESS edge set identity mismatch/);

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
  // #866 PR-C: 기대 집합은 route stationLines 전체다(legacy 간선 대상 집합 분기 삭제). station-d까지 materialization하면
  // 분모는 맞지만 materialization 식별(station set)이 route 역 집합과 어긋나 실패한다.
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    stationLines: [...stationLines(), extraLine],
    materialization: materialization([...stationLines(), extraLine]),
  }), unitPolicy), /materialization scoped station set identity mismatch/);
  // 간선이 요구하는 station-line(walkway-c3 → station-c:line-3)이 materialization에 없으면 분모 불일치다.
  const withoutTarget = materialization();
  for (const row of withoutTarget.rows.filter(({ stationId }) => stationId === "station-c")) withoutTarget.stateSummary[row.state] -= 1;
  withoutTarget.rows = withoutTarget.rows.filter(({ stationId }) => stationId !== "station-c");
  assert.throws(() => evaluateRouteAccessibilityEdges(input({
    materialization: rebindMaterialization(withoutTarget),
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

test("#866 PR-C route 입력에 역 단위 ENTRY/EXIT 간선이 있으면 정책 매핑과 무관하게 명시적으로 실패한다", () => {
  assert.equal(Object.hasOwn(policy.edgeDomainMap, "ENTRY"), false);
  assert.equal(Object.hasOwn(policy.edgeDomainMap, "EXIT"), false);
  for (const access of [
    edge({ edgeId: "entry-a", edgeType: "ENTRY", fromNodeId: "station-a", toNodeId: "station-a:line-1" }),
    edge({ edgeId: "exit-a", edgeType: "EXIT", fromNodeId: "station-a:line-1", toNodeId: "station-a" }),
  ]) {
    const routeEdges = [...platformRouteEdges(), access];
    assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges }), policyForEdges(routeEdges)),
      /route-edge input must not contain ENTRY\/EXIT edges/, access.edgeType);
  }
  // 예전 ENTRY/EXIT 매핑을 정책에 다시 넣으면 정책 검증이 거부한다.
  const legacyPolicy = policyForEdges(platformRouteEdges());
  legacyPolicy.edgeDomainMap = { ENTRY: { endpointTarget: "TO", domains: ["FACILITY"] }, ...legacyPolicy.edgeDomainMap };
  assert.throws(() => evaluateRouteAccessibilityEdges(input({ routeEdges: platformRouteEdges() }), legacyPolicy),
    /policy edge domain map keys/);
});
