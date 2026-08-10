import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildExitPathAdmission,
  canonicalExitPathAdmissionJson,
} from "./build-exit-path-admission.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";

const CAPTURED_AT = "2026-08-10T00:00:00.000Z";
const FRESH_UNTIL = "2026-08-12T00:00:00.000Z";
const OBSERVED_AT = "2026-08-11T00:00:00.000Z";

test("fresh production admission은 observed path와 exhaustive explicit zero만 Data #8 EXIT evidence로 만든다", () => {
  const input = validInput();

  const result = buildExitPathAdmission(input);

  assert.equal(result.decision, "GO");
  assert.deepEqual(result.cells.map(({ stationLineId, state, admissionReason }) => ({
    stationLineId, state, admissionReason,
  })), [{
    stationLineId: "station-a:line-1",
    state: "ADMITTED_EXIT_PATH",
    admissionReason: "OFFICIAL_EXIT_PATH_PRESENT",
  }, {
    stationLineId: "station-b:line-1",
    state: "ADMITTED_VERIFIED_ABSENCE",
    admissionReason: "OFFICIAL_EXIT_EXPLICIT_ZERO",
  }]);
  assert.deepEqual(result.stateSummary, {
    ADMITTED_EXIT_PATH: 1,
    ADMITTED_VERIFIED_ABSENCE: 1,
    BLOCKED_WITH_EVIDENCE: 0,
    MISSING: 0,
    STALE: 0,
    UNKNOWN: 0,
  });
  assert.deepEqual(result.queryPartition.summary, {
    queryCount: 2,
    joinedCount: 2,
    unmatchedCount: 0,
    ambiguousCount: 0,
  });
  assert.deepEqual(result.materializerEvidenceRows.map(({ stationId, state, evidenceKind }) => ({
    stationId, state, evidenceKind,
  })), [{
    stationId: "station-a",
    state: "VERIFIED_PRESENT",
    evidenceKind: "OBSERVED",
  }, {
    stationId: "station-b",
    state: "VERIFIED_ABSENT",
    evidenceKind: "EXPLICIT_ZERO",
  }]);
  const materialized = materializeStationLineAccessibility({
    candidate: input.candidate,
    stationLines: input.stationLines.map(({ stationId, lineId, operatorId }) => ({ stationId, lineId, operatorId })),
    evidenceRows: result.materializerEvidenceRows,
    observedAt: input.observedAt,
  });
  assert.deepEqual(materialized.rows.filter(({ domain }) => domain === "EXIT").map(({ state }) => state), [
    "VERIFIED_PRESENT", "VERIFIED_ABSENT",
  ]);
  assert.match(result.admissionDigest, /^[a-f0-9]{64}$/);
});

test("canonical output은 input ordering과 input object mutation에 독립적이다", () => {
  const firstInput = validInput();
  const secondInput = validInput();
  const original = JSON.stringify({ ...firstInput, snapshotBytes: [...firstInput.snapshotBytes] });
  secondInput.stationLines.reverse();

  const first = buildExitPathAdmission(firstInput);
  const second = buildExitPathAdmission(secondInput);

  assert.equal(JSON.stringify({ ...firstInput, snapshotBytes: [...firstInput.snapshotBytes] }), original);
  assert.equal(canonicalExitPathAdmissionJson(first), canonicalExitPathAdmissionJson(second));
});

test("sample·blocked source는 matching path가 있어도 admitted evidence를 만들지 않는다", () => {
  const input = validInput();
  input.sourceAdmission.decision = "BLOCKED";
  input.sourceAdmission.productionUseAllowed = false;

  const result = buildExitPathAdmission(input);

  assert.equal(result.decision, "NO_GO");
  assert.deepEqual(result.cells.map(({ state, admissionReason }) => ({ state, admissionReason })), [{
    state: "BLOCKED_WITH_EVIDENCE",
    admissionReason: "SOURCE_NOT_PRODUCTION_ADMITTED",
  }, {
    state: "BLOCKED_WITH_EVIDENCE",
    admissionReason: "SOURCE_NOT_PRODUCTION_ADMITTED",
  }]);
  assert.deepEqual(result.materializerEvidenceRows, []);
});

test("expired source는 observed·zero와 무관하게 모든 denominator cell을 STALE로 만든다", () => {
  const input = validInput();
  input.observedAt = FRESH_UNTIL;

  const result = buildExitPathAdmission(input);

  assert.deepEqual(result.cells.map(({ state }) => state), ["STALE", "STALE"]);
  assert.equal(result.stateSummary.STALE, 2);
  assert.equal(result.decision, "NO_GO");
  assert.deepEqual(result.materializerEvidenceRows, []);
});

test("provider no-data·failed·result omission은 explicit zero가 아니다", () => {
  for (const [state, expectedState, expectedReason] of [[
    "PROVIDER_NO_DATA", "UNKNOWN", "PROVIDER_NO_DATA_IS_NOT_ABSENCE",
  ], [
    "FAILED", "BLOCKED_WITH_EVIDENCE", "PROVIDER_REQUEST_FAILED",
  ]]) {
    const input = validInput();
    const snapshot = parseSnapshot(input);
    Object.assign(snapshot.results[1], { state, records: [], zeroEvidenceSha256: null });
    replaceSnapshot(input, snapshot);

    const result = buildExitPathAdmission(input);

    assert.equal(result.cells[1].state, expectedState);
    assert.equal(result.cells[1].admissionReason, expectedReason);
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.materializerEvidenceRows.length, 1);
  }

  const omitted = validInput();
  const omittedSnapshot = parseSnapshot(omitted);
  omittedSnapshot.results.pop();
  replaceSnapshot(omitted, omittedSnapshot);
  const omittedResult = buildExitPathAdmission(omitted);
  assert.equal(omittedResult.cells[1].state, "MISSING");
  assert.equal(omittedResult.cells[1].admissionReason, "OFFICIAL_EXIT_RESULT_MISSING");
  assert.equal(omittedResult.decision, "NO_GO");
});

test("non-exhaustive explicit zero는 verified absence가 아니고 partial coverage로 blocked다", () => {
  const input = validInput();
  const snapshot = parseSnapshot(input);
  snapshot.coverage.exhaustive = false;
  replaceSnapshot(input, snapshot);

  const result = buildExitPathAdmission(input);

  assert.equal(result.cells[1].state, "BLOCKED_WITH_EVIDENCE");
  assert.equal(result.cells[1].admissionReason, "SOURCE_COVERAGE_PARTIAL");
  assert.equal(result.stateSummary.ADMITTED_VERIFIED_ABSENCE, 0);
  assert.equal(result.decision, "NO_GO");
});

test("alias·unmatched·ambiguous query는 exact join으로 승격되지 않는다", () => {
  const unmatched = validInput();
  const unmatchedSnapshot = parseSnapshot(unmatched);
  unmatchedSnapshot.queryPlan[0].stationName = unmatched.stationLines[0].stationAliases[0];
  replaceSnapshot(unmatched, unmatchedSnapshot);
  const unmatchedResult = buildExitPathAdmission(unmatched);
  assert.equal(unmatchedResult.queryPartition.summary.unmatchedCount, 1);
  assert.equal(unmatchedResult.cells[0].state, "MISSING");
  assert.equal(unmatchedResult.decision, "NO_GO");

  const ambiguous = validInput();
  ambiguous.stationLines.push({
    ...ambiguous.stationLines[0],
    stationId: "station-a-duplicate",
    stationAliases: [],
  });
  refreshStationLineBindings(ambiguous);
  const ambiguousResult = buildExitPathAdmission(ambiguous);
  assert.equal(ambiguousResult.queryPartition.summary.ambiguousCount, 1);
  assert.equal(ambiguousResult.decision, "NO_GO");
  assert.equal(ambiguousResult.stateSummary.ADMITTED_EXIT_PATH, 0);
});

test("두 provider query가 같은 canonical station-line에 결속되면 fail closed한다", () => {
  const input = validInput();
  const snapshot = parseSnapshot(input);
  snapshot.queryPlan.push({
    ...snapshot.queryPlan[0],
    queryId: "query-3",
    providerStationId: "S1-duplicate",
  });
  snapshot.coverage.queryIds.push("query-3");
  snapshot.results.push({
    queryId: "query-3",
    state: "OBSERVED_EXIT_PATH",
    records: [record("path-3")],
    zeroEvidenceSha256: null,
  });
  replaceSnapshot(input, snapshot);

  assert.throws(() => buildExitPathAdmission(input), /duplicate EXIT station-line mapping/);
});

test("duplicate query/result/record와 malformed result shape는 output 전에 거부한다", () => {
  const duplicateQuery = validInput();
  const duplicateQuerySnapshot = parseSnapshot(duplicateQuery);
  duplicateQuerySnapshot.queryPlan.push({ ...duplicateQuerySnapshot.queryPlan[0] });
  duplicateQuery.snapshotBytes = canonicalBytes(duplicateQuerySnapshot);
  assert.throws(() => buildExitPathAdmission(duplicateQuery), /duplicate EXIT queryId/);

  const duplicateResult = validInput();
  const duplicateResultSnapshot = parseSnapshot(duplicateResult);
  duplicateResultSnapshot.results.push({ ...duplicateResultSnapshot.results[0] });
  duplicateResult.snapshotBytes = canonicalBytes(duplicateResultSnapshot);
  assert.throws(() => buildExitPathAdmission(duplicateResult), /duplicate EXIT query result/);

  const duplicateRecord = validInput();
  const duplicateRecordSnapshot = parseSnapshot(duplicateRecord);
  duplicateRecordSnapshot.results[0].records.push({ ...duplicateRecordSnapshot.results[0].records[0] });
  duplicateRecord.snapshotBytes = canonicalBytes(duplicateRecordSnapshot);
  assert.throws(() => buildExitPathAdmission(duplicateRecord), /duplicate EXIT record/);

  const blankObserved = validInput();
  const blankObservedSnapshot = parseSnapshot(blankObserved);
  blankObservedSnapshot.results[0].records = [];
  blankObserved.snapshotBytes = canonicalBytes(blankObservedSnapshot);
  assert.throws(() => buildExitPathAdmission(blankObserved), /observed EXIT path result shape mismatch/);

  const zeroWithRecord = validInput();
  const zeroWithRecordSnapshot = parseSnapshot(zeroWithRecord);
  zeroWithRecordSnapshot.results[1].records = [record("impossible-zero-record")];
  zeroWithRecord.snapshotBytes = canonicalBytes(zeroWithRecordSnapshot);
  assert.throws(() => buildExitPathAdmission(zeroWithRecord), /explicit zero EXIT result must not contain records/);
});

test("candidate/source/snapshot/mapping/admission identity drift는 fail closed한다", () => {
  const cases = [
    ["station set", (input) => { input.candidate.stationSetSha256 = "0".repeat(64); }, /station set identity mismatch/],
    ["station-line set", (input) => { input.stationLineSetSha256 = "0".repeat(64); }, /station-line denominator identity mismatch/],
    ["mapping", (input) => { input.stationLineMappingSha256 = "0".repeat(64); }, /station-line mapping identity mismatch/],
    ["source set", (input) => { input.candidate.sourceSetSha256 = "0".repeat(64); }, /source snapshot set identity mismatch/],
    ["membership", (input) => {
      input.sourceSnapshots[0].snapshotId = "another-snapshot";
      input.candidate.sourceSetSha256 = sha256(JSON.stringify(input.sourceSnapshots));
      input.sourceAdmission.sourceSnapshotSetHash = input.candidate.sourceSetSha256;
    }, /source snapshot membership mismatch/],
    ["raw", (input) => { input.sourceAdmission.rawSha256 = "0".repeat(64); }, /EXIT source admission identity mismatch/],
    ["query plan", (input) => { input.sourceAdmission.queryPlanSha256 = "0".repeat(64); }, /EXIT source admission identity mismatch/],
    ["coverage", (input) => { input.sourceAdmission.coverageScopeSha256 = "0".repeat(64); }, /EXIT source admission identity mismatch/],
  ];
  for (const [label, mutate, expected] of cases) {
    const input = validInput();
    mutate(input);
    assert.throws(() => buildExitPathAdmission(input), expected, label);
  }
});

test("non-canonical/invalid snapshot bytes와 extra key는 fail closed한다", () => {
  const pretty = validInput();
  pretty.snapshotBytes = Buffer.from(`${JSON.stringify(parseSnapshot(pretty), null, 2)}\n`);
  assert.throws(() => buildExitPathAdmission(pretty), /EXIT snapshot must be canonical JSON/);

  const invalidUtf8 = validInput();
  invalidUtf8.snapshotBytes = Buffer.from([0xff, 0xfe]);
  assert.throws(() => buildExitPathAdmission(invalidUtf8), /EXIT snapshot must be strict UTF-8 JSON/);

  const extra = validInput();
  const extraSnapshot = parseSnapshot(extra);
  extraSnapshot.unexpected = true;
  extra.snapshotBytes = canonicalBytes(extraSnapshot);
  assert.throws(() => buildExitPathAdmission(extra), /EXIT snapshot keys mismatch/);
});

test("semantic snapshot arrays의 non-canonical order는 새 raw identity로 승인되지 않는다", () => {
  const cases = [[
    "queryPlan",
    (snapshot) => snapshot.queryPlan.reverse(),
  ], [
    "results",
    (snapshot) => snapshot.results.reverse(),
  ], [
    "coverage queryIds",
    (snapshot) => snapshot.coverage.queryIds.reverse(),
  ], [
    "records",
    (snapshot) => {
      snapshot.results[0].records = [record("path-z"), record("path-a")];
    },
  ]];

  for (const [label, mutate] of cases) {
    const input = validInput();
    const snapshot = parseSnapshot(input);
    mutate(snapshot);
    replaceSnapshot(input, snapshot);

    assert.throws(
      () => buildExitPathAdmission(input),
      /EXIT snapshot arrays must use canonical byte order/,
      label,
    );
  }
});

test("invalid/future time과 approval ordering은 fail closed한다", () => {
  const invalidTime = validInput();
  const invalidSnapshot = parseSnapshot(invalidTime);
  invalidSnapshot.capturedAt = "2026-08-10";
  invalidTime.snapshotBytes = canonicalBytes(invalidSnapshot);
  assert.throws(() => buildExitPathAdmission(invalidTime), /EXIT snapshot capturedAt must be an RFC 3339 UTC timestamp/);

  const futureSnapshot = validInput();
  const future = parseSnapshot(futureSnapshot);
  future.capturedAt = "2026-08-11T00:00:00.001Z";
  futureSnapshot.snapshotBytes = canonicalBytes(future);
  assert.throws(() => buildExitPathAdmission(futureSnapshot), /EXIT snapshot is future-dated/);

  const futureApproval = validInput();
  futureApproval.sourceAdmission.approvedAt = "2026-08-11T00:00:00.001Z";
  assert.throws(() => buildExitPathAdmission(futureApproval), /EXIT source admission approval time mismatch/);

  const preSnapshotApproval = validInput();
  preSnapshotApproval.sourceAdmission.approvedAt = "2026-08-09T23:59:59.999Z";
  assert.throws(() => buildExitPathAdmission(preSnapshotApproval), /EXIT source admission approval time mismatch/);
});

function validInput() {
  const stationLines = [{
    stationId: "station-a",
    stationName: "가역",
    stationAliases: ["가"],
    regionId: "capital",
    lineId: "line-1",
    lineName: "1호선",
    operatorId: "operator-1",
    operatorName: "운영사",
  }, {
    stationId: "station-b",
    stationName: "나역",
    stationAliases: [],
    regionId: "capital",
    lineId: "line-1",
    lineName: "1호선",
    operatorId: "operator-1",
    operatorName: "운영사",
  }];
  const queryPlan = stationLines.map((line, index) => ({
    queryId: `query-${index + 1}`,
    providerOperatorId: "OP",
    providerLineId: "L1",
    providerStationId: `S${index + 1}`,
    operatorName: line.operatorName,
    lineName: line.lineName,
    stationName: line.stationName,
    regionId: line.regionId,
  }));
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "exit-path-normalized-source-snapshot",
    sourceId: "official-exit-path-source",
    snapshotId: "official-exit-path-source-20260810",
    capturedAt: CAPTURED_AT,
    freshUntil: FRESH_UNTIL,
    coverage: {
      exhaustive: true,
      queryIds: queryPlan.map(({ queryId }) => queryId),
    },
    queryPlan,
    results: [{
      queryId: "query-1",
      state: "OBSERVED_EXIT_PATH",
      records: [record("path-1")],
      zeroEvidenceSha256: null,
    }, {
      queryId: "query-2",
      state: "EXPLICIT_ZERO",
      records: [],
      zeroEvidenceSha256: sha256("official-zero-query-2"),
    }],
  };
  const snapshotBytes = canonicalBytes(snapshot);
  const sourceSnapshots = [{
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    rawSha256: sha256(snapshotBytes),
  }];
  const stationLineMappingSha256 = mappingSha256(stationLines);
  const candidate = {
    candidateId: "candidate-capital",
    stationSetSha256: stationSetSha256(stationLines),
    sourceSetSha256: sha256(JSON.stringify(sourceSnapshots)),
    mappingContractVersion: "exit-path-v1",
    materializerVersion: "1",
  };
  return {
    candidate,
    observedAt: OBSERVED_AT,
    sourceAdmission: {
      schemaVersion: 1,
      artifactKind: "exit-path-source-admission",
      candidateId: candidate.candidateId,
      sourceId: snapshot.sourceId,
      snapshotId: snapshot.snapshotId,
      rawSha256: sha256(snapshotBytes),
      sourceSnapshotSetHash: candidate.sourceSetSha256,
      stationSetSha256: candidate.stationSetSha256,
      stationLineMappingSha256,
      queryPlanSha256: sha256(canonicalJson(snapshot.queryPlan)),
      coverageScopeSha256: sha256(canonicalJson(snapshot.coverage)),
      mappingContractVersion: candidate.mappingContractVersion,
      decision: "APPROVED",
      productionUseAllowed: true,
      approvedAt: CAPTURED_AT,
      provenanceId: sha256("provenance"),
      licenseId: sha256("license"),
    },
    sourceSnapshots,
    stationLines,
    stationLineMappingSha256,
    stationLineSetSha256: stationLineSetSha256(stationLines),
    snapshotBytes,
  };
}

function record(recordId) {
  const payload = { recordId, classification: "EXIT_TO_PLATFORM_PATH" };
  return { ...payload, providerRecordHash: sha256(canonicalJson(payload)) };
}

function parseSnapshot(input) {
  return JSON.parse(Buffer.from(input.snapshotBytes).toString("utf8"));
}

function replaceSnapshot(input, snapshot) {
  input.snapshotBytes = canonicalBytes(snapshot);
  input.sourceSnapshots[0].rawSha256 = sha256(input.snapshotBytes);
  input.candidate.sourceSetSha256 = sha256(JSON.stringify(input.sourceSnapshots));
  Object.assign(input.sourceAdmission, {
    rawSha256: input.sourceSnapshots[0].rawSha256,
    sourceSnapshotSetHash: input.candidate.sourceSetSha256,
    queryPlanSha256: sha256(canonicalJson([...snapshot.queryPlan].sort((left, right) => compareBytes(
      left.queryId, right.queryId,
    )))),
    coverageScopeSha256: sha256(canonicalJson({
      exhaustive: snapshot.coverage.exhaustive,
      queryIds: [...snapshot.coverage.queryIds].sort(compareBytes),
    })),
  });
}

function refreshStationLineBindings(input) {
  input.candidate.stationSetSha256 = stationSetSha256(input.stationLines);
  input.stationLineSetSha256 = stationLineSetSha256(input.stationLines);
  input.stationLineMappingSha256 = mappingSha256(input.stationLines);
  input.sourceAdmission.stationSetSha256 = input.candidate.stationSetSha256;
  input.sourceAdmission.stationLineMappingSha256 = input.stationLineMappingSha256;
}

function stationSetSha256(stationLines) {
  return sha256(canonicalJson([...new Set(stationLines.map(({ stationId }) => stationId))].sort(compareBytes)));
}

function stationLineSetSha256(stationLines) {
  return sha256(canonicalJson(stationLines.map(({ stationId, lineId, operatorId }) => ({
    stationId, lineId, operatorId,
  })).sort(compareStationLines)));
}

function mappingSha256(stationLines) {
  return sha256(canonicalJson(stationLines.map((line) => ({
    ...line,
    stationAliases: [...new Set(line.stationAliases)].sort(compareBytes),
  })).sort(compareStationLines)));
}

function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  }
  return value;
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
