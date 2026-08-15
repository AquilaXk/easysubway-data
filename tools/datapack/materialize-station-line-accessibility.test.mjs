import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalStationLineAccessibilityJson,
  canonicalStationLineAccessibilityPayloadJson,
  materializeStationLineAccessibility,
} from "./materialize-station-line-accessibility.mjs";

const HASH = "a".repeat(64);
const NOW = "2026-08-09T00:00:00.000Z";

function candidate() {
  return {
    candidateId: "candidate-seoul-1",
    stationSetSha256: "e".repeat(64),
    sourceSetSha256: "f".repeat(64),
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
  };
}

function stationLines() {
  return [
    { stationId: "station-b", lineId: "line-2", operatorId: "operator-1" },
    { stationId: "station-a", lineId: "line-1", operatorId: "operator-1" },
  ];
}

function evidence(overrides = {}) {
  return {
    candidateId: "candidate-seoul-1",
    stationSetSha256: "e".repeat(64),
    sourceSetSha256: "f".repeat(64),
    sourceId: "official-operator-accessibility",
    sourceSnapshotId: "official-operator-accessibility-20260808",
    stationId: "station-a",
    lineId: "line-1",
    operatorId: "operator-1",
    domain: "FACILITY",
    state: "VERIFIED_PRESENT",
    evidenceRawSha256: HASH,
    providerRecordHash: "d".repeat(64),
    capturedAt: "2026-08-08T00:00:00.000Z",
    freshUntil: "2026-08-10T00:00:00.000Z",
    provenanceId: "official-operator",
    licenseId: "public-data-license",
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    evidenceKind: "OBSERVED",
    evidenceReason: "official facility record",
    ...overrides,
  };
}

function input(rows = [evidence()]) {
  return { candidate: candidate(), stationLines: stationLines(), evidenceRows: rows, observedAt: NOW };
}

test("canonical stationLine×FACILITY|EXIT|TRANSFER를 완전 materialize하고 입력을 변경하지 않는다", () => {
  const value = input([
    evidence(),
    evidence({ domain: "EXIT", sourceId: "municipal-exit", sourceSnapshotId: "municipal-exit-20260808", state: "VERIFIED_ABSENT", evidenceKind: "EXPLICIT_ZERO", evidenceReason: "official zero exits" }),
    evidence({ domain: "TRANSFER", sourceId: "rail-transfer", sourceSnapshotId: "rail-transfer-20260808", state: "NOT_APPLICABLE", evidenceKind: "CURRENT_APPLICABILITY_RULE", evidenceReason: "current line has no transfer boundary" }),
  ]);
  const before = structuredClone(value);

  const result = materializeStationLineAccessibility(value);

  assert.deepEqual(value, before);
  assert.deepEqual(result.candidate, candidate());
  assert.deepEqual(result.rows.slice(0, 3).map((row) => ({
    domain: row.domain,
    stationSetSha256: row.stationSetSha256,
    sourceSetSha256: row.sourceSetSha256,
    sourceId: row.sourceId,
    sourceSnapshotId: row.sourceSnapshotId,
    provenanceId: row.provenanceId,
    licenseId: row.licenseId,
  })), [
    { domain: "EXIT", stationSetSha256: "e".repeat(64), sourceSetSha256: "f".repeat(64), sourceId: "municipal-exit", sourceSnapshotId: "municipal-exit-20260808", provenanceId: "official-operator", licenseId: "public-data-license" },
    { domain: "FACILITY", stationSetSha256: "e".repeat(64), sourceSetSha256: "f".repeat(64), sourceId: "official-operator-accessibility", sourceSnapshotId: "official-operator-accessibility-20260808", provenanceId: "official-operator", licenseId: "public-data-license" },
    { domain: "TRANSFER", stationSetSha256: "e".repeat(64), sourceSetSha256: "f".repeat(64), sourceId: "rail-transfer", sourceSnapshotId: "rail-transfer-20260808", provenanceId: "official-operator", licenseId: "public-data-license" },
  ]);
  assert.deepEqual(result.rows.map(({ stationId, lineId, domain, state }) => ({ stationId, lineId, domain, state })), [
    { stationId: "station-a", lineId: "line-1", domain: "EXIT", state: "VERIFIED_ABSENT" },
    { stationId: "station-a", lineId: "line-1", domain: "FACILITY", state: "VERIFIED_PRESENT" },
    { stationId: "station-a", lineId: "line-1", domain: "TRANSFER", state: "NOT_APPLICABLE" },
    { stationId: "station-b", lineId: "line-2", domain: "EXIT", state: "MISSING" },
    { stationId: "station-b", lineId: "line-2", domain: "FACILITY", state: "MISSING" },
    { stationId: "station-b", lineId: "line-2", domain: "TRANSFER", state: "MISSING" },
  ]);
  assert.deepEqual(result.stateSummary, {
    VERIFIED_PRESENT: 1,
    VERIFIED_ABSENT: 1,
    NOT_APPLICABLE: 1,
    UNKNOWN: 0,
    MISSING: 3,
    STALE: 0,
  });
  assert.match(result.materializationDigest, /^[a-f0-9]{64}$/);
});

test("admitted row 없음, 만료와 blank/default/provider no-data/unsupported를 파생 상태로 만든다", () => {
  const result = materializeStationLineAccessibility(input([
    evidence({ freshUntil: NOW }),
    evidence({ domain: "EXIT", state: "UNKNOWN", evidenceKind: "BLANK", evidenceReason: "blank value" }),
    evidence({ domain: "TRANSFER", state: "UNKNOWN", evidenceKind: "PROVIDER_NO_DATA", evidenceReason: "provider reports no data" }),
    evidence({ stationId: "station-b", lineId: "line-2", domain: "FACILITY", state: "UNKNOWN", evidenceKind: "DEFAULT", evidenceReason: "default value" }),
  ]));

  assert.equal(result.rows.find((row) => row.stationId === "station-a" && row.domain === "FACILITY").state, "STALE");
  assert.equal(result.rows.find((row) => row.stationId === "station-a" && row.domain === "EXIT").state, "UNKNOWN");
  assert.equal(result.rows.find((row) => row.stationId === "station-a" && row.domain === "TRANSFER").state, "UNKNOWN");
  assert.equal(result.rows.find((row) => row.stationId === "station-b" && row.domain === "FACILITY").state, "UNKNOWN");
  assert.equal(result.rows.find((row) => row.stationId === "station-b" && row.domain === "EXIT").state, "MISSING");
});

test("duplicate, conflict, unmapped, candidate/station/mapping identity mismatch는 fail closed한다", () => {
  assert.throws(() => materializeStationLineAccessibility(input([evidence(), evidence()])), /duplicate evidence row/);
  assert.throws(() => materializeStationLineAccessibility(input([
    evidence(), evidence({ state: "UNKNOWN", evidenceKind: "DEFAULT", evidenceReason: "default value" }),
  ])), /conflicting evidence rows/);
  assert.throws(() => materializeStationLineAccessibility(input([evidence({ stationId: "station-z" })])), /unmapped evidence row/);
  assert.throws(() => materializeStationLineAccessibility(input([evidence({ candidateId: "other-candidate" })])), /candidate identity mismatch/);
  assert.throws(() => materializeStationLineAccessibility(input([evidence({ stationSetSha256: "0".repeat(64) })])), /station set identity mismatch/);
  assert.throws(() => materializeStationLineAccessibility(input([evidence({ sourceSetSha256: "1".repeat(64) })])), /source set identity mismatch/);
  assert.throws(() => materializeStationLineAccessibility(input([evidence({ mappingContractVersion: "other-mapping" })])), /mapping identity mismatch/);
  assert.throws(() => materializeStationLineAccessibility(input([evidence({ materializerVersion: "2" })])), /materializer identity mismatch/);
  assert.throws(() => materializeStationLineAccessibility({
    ...input(), stationLines: [{ stationId: "station-a", lineId: "line-1", operatorId: "operator-x" }],
  }), /station line identity mismatch/);
});

test("근거 없는 VERIFIED_ABSENT와 NOT_APPLICABLE 및 닫히지 않은 schema를 거부한다", () => {
  assert.throws(() => materializeStationLineAccessibility(input([
    evidence({ state: "VERIFIED_ABSENT", evidenceKind: "OBSERVED" }),
  ])), /VERIFIED_ABSENT evidence kind/);
  assert.throws(() => materializeStationLineAccessibility(input([
    evidence({ state: "NOT_APPLICABLE", evidenceKind: "CURRENT_APPLICABILITY_RULE", evidenceReason: "" }),
  ])), /NOT_APPLICABLE evidence reason/);
  assert.throws(() => materializeStationLineAccessibility(input([
    evidence({ unexpected: true }),
  ])), /evidence row keys mismatch/);
});

test("exact provider result 03의 EV/ES/WCLF carrier를 하나의 FACILITY terminal cell로 정규화한다", () => {
  const rows = ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"].map((facilityType) => evidence({
    stationId: "station-b35616704ce3",
    lineId: "seoul-2",
    operatorId: "seoul-metro",
    sourceId: "kric-station-convenience-standard",
    facilityType,
    state: "UNVERIFIED_EVIDENCE_BLOCKED",
    evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED",
    terminalPolicy: "EXACT_TUPLE_PROVIDER_RESULT_03",
    providerResultCode: "03",
    strictRouteEligible: false,
    strictRouteEligibleReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED",
    installationStatus: "UNKNOWN",
    operationalStatus: "UNKNOWN",
    statusMeaning: "PROVIDER_RESULT_UNVERIFIED",
    confidence: 0,
    providerRecordHash: null,
    providerResponseSha256: "c".repeat(64),
    evidenceHash: terminalEvidenceHash(facilityType),
    evidenceReason: "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.",
  }));

  const result = materializeStationLineAccessibility({ candidate: candidate(), stationLines: [{ stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro" }], evidenceRows: rows, observedAt: NOW });

  const cell = result.rows.find(({ stationId, lineId, domain }) => stationId === "station-b35616704ce3" && lineId === "seoul-2" && domain === "FACILITY");
  assert.equal(cell.state, "UNVERIFIED_EVIDENCE_BLOCKED");
  assert.equal(cell.terminalPolicy, "EXACT_TUPLE_PROVIDER_RESULT_03");
  assert.equal(cell.providerResultCode, "03");
  assert.equal(cell.providerResponseSha256, "c".repeat(64));
  assert.equal(result.rows.filter(({ stationId, lineId, domain }) => stationId === "station-b35616704ce3" && lineId === "seoul-2" && domain === "FACILITY").length, 1);
  for (const field of ["stationId", "lineId", "sourceId"]) {
    const invalid = structuredClone(rows); invalid[0][field] = "wrong";
    assert.throws(() => materializeStationLineAccessibility({ candidate: candidate(), stationLines: [{ stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro" }], evidenceRows: invalid, observedAt: NOW }), /terminal evidence (tuple|identity) mismatch/);
  }
  const tampered = structuredClone(rows); tampered[0].evidenceHash = "0".repeat(64);
  assert.throws(() => materializeStationLineAccessibility({ candidate: candidate(), stationLines: [{ stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro" }], evidenceRows: tampered, observedAt: NOW }), /terminal evidence hash mismatch/);
});

function terminalEvidenceHash(facilityType) {
  return createHash("sha256").update(JSON.stringify({ facilityType, lineId: "seoul-2", operatorId: "seoul-metro", providerResponseSha256: "c".repeat(64), sourceSnapshotId: "official-operator-accessibility-20260808", stationId: "station-b35616704ce3", terminalPolicy: "EXACT_TUPLE_PROVIDER_RESULT_03" })).digest("hex");
}

test("evidence 시간은 canonical UTC와 capturedAt <= observedAt < freshUntil 순서를 fail closed로 강제한다", () => {
  assert.doesNotThrow(() => materializeStationLineAccessibility(input([
    evidence({ capturedAt: NOW, freshUntil: "2026-08-09T00:00:00.001Z" }),
  ])));
  assert.equal(materializeStationLineAccessibility(input([
    evidence({ freshUntil: NOW }),
  ])).rows.find((row) => row.stationId === "station-a" && row.domain === "FACILITY").state, "STALE");
  assert.throws(() => materializeStationLineAccessibility(input([
    evidence({ capturedAt: "2026-08-09T00:00:00.001Z", freshUntil: "2026-08-10T00:00:00.000Z" }),
  ])), /capturedAt must not be after observedAt/);
  assert.throws(() => materializeStationLineAccessibility(input([
    evidence({ capturedAt: "2026-08-09T00:00:00.000Z", freshUntil: "2026-08-09T00:00:00.000Z" }),
  ])), /freshUntil must be after capturedAt/);
  for (const capturedAt of ["2026-08-09", "2026-08-09T00:00:00+00:00", "2026-02-30T00:00:00Z"]) {
    assert.throws(() => materializeStationLineAccessibility(input([
      evidence({ capturedAt }),
    ])), /evidence capturedAt must be an RFC 3339 UTC timestamp/);
  }
});

test("동일 epoch의 fractional-second 표기는 canonical payload와 digest를 바꾸지 않는다", () => {
  const fractional = materializeStationLineAccessibility(input([
    evidence({ capturedAt: "2026-08-08T00:00:00.000Z", freshUntil: "2026-08-10T00:00:00.000Z" }),
  ]));
  const wholeSecond = materializeStationLineAccessibility(input([
    evidence({ capturedAt: "2026-08-08T00:00:00Z", freshUntil: "2026-08-10T00:00:00Z" }),
  ]));

  assert.equal(canonicalStationLineAccessibilityJson(fractional), canonicalStationLineAccessibilityJson(wholeSecond));
  assert.equal(fractional.materializationDigest, wholeSecond.materializationDigest);
  assert.equal(wholeSecond.rows.find((row) => row.domain === "FACILITY").capturedAt, "2026-08-08T00:00:00.000Z");
  assert.equal(wholeSecond.rows.find((row) => row.domain === "FACILITY").freshUntil, "2026-08-10T00:00:00.000Z");
});

test("canonical ordering과 digest는 입력 순서와 반복에 무관하게 byte-identical이다", () => {
  const rows = [
    evidence({ stationId: "station-b", lineId: "line-2", domain: "TRANSFER", state: "UNKNOWN", evidenceKind: "UNSUPPORTED", evidenceReason: "unsupported source" }),
    evidence({ stationId: "station-a", lineId: "line-1", domain: "EXIT", state: "UNKNOWN", evidenceKind: "NULL", evidenceReason: "null record" }),
  ];
  const first = materializeStationLineAccessibility(input(rows));
  const second = materializeStationLineAccessibility(input([...rows].reverse()));
  const firstPayloadBytes = canonicalStationLineAccessibilityPayloadJson(first);
  const secondPayloadBytes = canonicalStationLineAccessibilityPayloadJson(second);
  const firstBytes = canonicalStationLineAccessibilityJson(first);
  const secondBytes = canonicalStationLineAccessibilityJson(second);

  assert.equal(firstPayloadBytes, secondPayloadBytes);
  assert.equal(firstBytes, secondBytes);
  assert.equal(first.materializationDigest, createHash("sha256").update(firstPayloadBytes).digest("hex"));
  assert.equal(firstBytes, JSON.stringify(first));
});
