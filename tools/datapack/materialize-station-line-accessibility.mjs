import { createHash } from "node:crypto";

import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const DOMAINS = ["FACILITY", "EXIT", "TRANSFER"];
const STATES = [
  "VERIFIED_PRESENT",
  "VERIFIED_ABSENT",
  "NOT_APPLICABLE",
  "UNKNOWN",
  "MISSING",
  "STALE",
];
const UNKNOWN_KINDS = new Set(["BLANK", "NULL", "DEFAULT", "PROVIDER_NO_DATA", "UNSUPPORTED"]);
const EVIDENCE_KEYS = [
  "candidateId", "stationSetSha256", "sourceSetSha256", "stationId", "lineId", "operatorId", "domain", "state",
  "sourceId", "sourceSnapshotId", "evidenceRawSha256", "providerRecordHash", "capturedAt", "freshUntil",
  "provenanceId", "licenseId", "mappingContractVersion", "materializerVersion", "evidenceKind", "evidenceReason",
];
const STATION_LINE_KEYS = ["stationId", "lineId", "operatorId"];

export function materializeStationLineAccessibility(input) {
  assertKeys(input, ["candidate", "stationLines", "evidenceRows", "observedAt"], "input keys");
  assertKeys(input.candidate, ["candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion"], "candidate identity keys");
  const candidate = canonicalObject(input.candidate);
  for (const [key, value] of Object.entries(candidate)) assertNonBlank(value, key);
  for (const key of ["stationSetSha256", "sourceSetSha256"]) {
    if (!/^[a-f0-9]{64}$/.test(candidate[key])) throw new Error(`candidate ${key} must be sha256`);
  }
  const observedAt = requiredUtcInstant(input.observedAt, "observedAt");
  if (!Array.isArray(input.stationLines) || !Array.isArray(input.evidenceRows)) {
    throw new Error("stationLines and evidenceRows must be arrays");
  }

  const canonicalLines = input.stationLines.map((line) => {
    assertKeys(line, STATION_LINE_KEYS, "station line keys");
    for (const key of STATION_LINE_KEYS) assertNonBlank(line[key], `station line ${key}`);
    return { stationId: line.stationId, lineId: line.lineId, operatorId: line.operatorId };
  }).sort(compareStationLines);
  const lineByStationLine = new Map();
  const operatorByStationAndLine = new Map();
  for (const line of canonicalLines) {
    const key = stationLineKey(line);
    if (lineByStationLine.has(key)) throw new Error("duplicate canonical station line");
    const stationAndLine = `${line.stationId}\u0000${line.lineId}`;
    const existingOperator = operatorByStationAndLine.get(stationAndLine);
    if (existingOperator && existingOperator !== line.operatorId) throw new Error("station line identity mismatch");
    lineByStationLine.set(key, line);
    operatorByStationAndLine.set(stationAndLine, line.operatorId);
  }

  const evidenceByTarget = new Map();
  for (const row of input.evidenceRows) {
    validateEvidence(row, candidate, observedAt);
    const baseKey = `${row.stationId}\u0000${row.lineId}`;
    const exactLine = lineByStationLine.get(stationLineKey(row));
    if (!exactLine) {
      if (canonicalLines.some((line) => `${line.stationId}\u0000${line.lineId}` === baseKey)) {
        throw new Error("station line identity mismatch");
      }
      throw new Error("unmapped evidence row");
    }
    const key = `${stationLineKey(row)}\u0000${row.domain}`;
    const existing = evidenceByTarget.get(key);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(row)) throw new Error("duplicate evidence row");
      throw new Error("conflicting evidence rows");
    }
    evidenceByTarget.set(key, row);
  }

  const rows = [];
  for (const line of canonicalLines) {
    for (const domain of [...DOMAINS].sort(compareBytes)) {
      const evidence = evidenceByTarget.get(`${stationLineKey(line)}\u0000${domain}`);
      const state = evidence ? derivedState(evidence, observedAt) : "MISSING";
      rows.push(canonicalObject({
        ...candidate,
        stationId: line.stationId,
        lineId: line.lineId,
        operatorId: line.operatorId,
        domain,
        state,
        sourceId: evidence?.sourceId ?? null,
        sourceSnapshotId: evidence?.sourceSnapshotId ?? null,
        evidenceRawSha256: evidence?.evidenceRawSha256 ?? null,
        providerRecordHash: evidence?.providerRecordHash ?? null,
        capturedAt: evidence?.capturedAt ?? null,
        freshUntil: evidence?.freshUntil ?? null,
        provenanceId: evidence?.provenanceId ?? null,
        licenseId: evidence?.licenseId ?? null,
        evidenceKind: evidence?.evidenceKind ?? null,
        evidenceReason: evidence?.evidenceReason ?? null,
      }));
    }
  }

  const stateSummary = Object.fromEntries(STATES.map((state) => [state, 0]));
  for (const row of rows) stateSummary[row.state] += 1;
  const payload = canonicalObject({ candidate, rows, stateSummary });
  return canonicalObject({
    ...payload,
    materializationDigest: sha256(canonicalJson(payload)),
  });
}

export function canonicalStationLineAccessibilityJson(result) {
  assertKeys(result, ["candidate", "rows", "stateSummary", "materializationDigest"], "materialization keys");
  return canonicalJson(result);
}

export function canonicalStationLineAccessibilityPayloadJson(result) {
  assertKeys(result, ["candidate", "rows", "stateSummary", "materializationDigest"], "materialization keys");
  return canonicalJson({ candidate: result.candidate, rows: result.rows, stateSummary: result.stateSummary });
}

function validateEvidence(row, candidate, observedAt) {
  assertKeys(row, EVIDENCE_KEYS, "evidence row keys");
  if (row.candidateId !== candidate.candidateId) throw new Error("candidate identity mismatch");
  if (row.stationSetSha256 !== candidate.stationSetSha256) throw new Error("station set identity mismatch");
  if (row.sourceSetSha256 !== candidate.sourceSetSha256) throw new Error("source set identity mismatch");
  if (row.mappingContractVersion !== candidate.mappingContractVersion) throw new Error("mapping identity mismatch");
  if (row.materializerVersion !== candidate.materializerVersion) throw new Error("materializer identity mismatch");
  for (const key of ["candidateId", "stationSetSha256", "sourceSetSha256", "stationId", "lineId", "operatorId", "domain", "state", "sourceId", "sourceSnapshotId", "provenanceId", "licenseId", "mappingContractVersion", "materializerVersion", "evidenceKind"]) {
    assertNonBlank(row[key], `evidence ${key}`);
  }
  if (!DOMAINS.includes(row.domain)) throw new Error("unsupported evidence domain");
  if (!STATES.includes(row.state) || row.state === "MISSING" || row.state === "STALE") {
    throw new Error("unsupported admitted evidence state");
  }
  for (const key of ["stationSetSha256", "sourceSetSha256", "evidenceRawSha256", "providerRecordHash"]) {
    if (!/^[a-f0-9]{64}$/.test(row[key])) throw new Error(`evidence ${key} must be sha256`);
  }
  const capturedAt = requiredUtcInstant(row.capturedAt, "evidence capturedAt");
  const freshUntil = requiredUtcInstant(row.freshUntil, "evidence freshUntil");
  if (capturedAt > observedAt) throw new Error("capturedAt must not be after observedAt");
  if (freshUntil <= capturedAt) throw new Error("freshUntil must be after capturedAt");
  if (row.state === "VERIFIED_ABSENT" && !["EXHAUSTIVE_LIST", "EXPLICIT_ZERO"].includes(row.evidenceKind)) {
    throw new Error("VERIFIED_ABSENT evidence kind must be EXHAUSTIVE_LIST or EXPLICIT_ZERO");
  }
  if (row.state === "NOT_APPLICABLE" && row.evidenceKind !== "CURRENT_APPLICABILITY_RULE") {
    throw new Error("NOT_APPLICABLE evidence kind must be CURRENT_APPLICABILITY_RULE");
  }
  if (row.state === "NOT_APPLICABLE" && (typeof row.evidenceReason !== "string" || row.evidenceReason.trim() === "")) {
    throw new Error("NOT_APPLICABLE evidence reason is required");
  }
  assertNonBlank(row.evidenceReason, "evidence evidenceReason");
  if (UNKNOWN_KINDS.has(row.evidenceKind) && row.state !== "UNKNOWN") {
    throw new Error("unknown evidence kind requires UNKNOWN state");
  }
  if (row.state === "UNKNOWN" && !UNKNOWN_KINDS.has(row.evidenceKind)) {
    throw new Error("UNKNOWN state requires blank/null/default/provider-no-data/unsupported evidence");
  }
  if (row.state === "VERIFIED_PRESENT" && row.evidenceKind !== "OBSERVED") {
    throw new Error("VERIFIED_PRESENT evidence kind must be OBSERVED");
  }
}

function derivedState(evidence, observedAt) {
  if (requiredUtcInstant(evidence.freshUntil, "evidence freshUntil") <= observedAt) return "STALE";
  if (UNKNOWN_KINDS.has(evidence.evidenceKind)) return "UNKNOWN";
  return evidence.state;
}

function stationLineKey(value) {
  return `${value.stationId}\u0000${value.lineId}\u0000${value.operatorId}`;
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function assertNonBlank(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-blank string`);
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} mismatch`);
  }
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
