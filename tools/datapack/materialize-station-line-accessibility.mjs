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
const TERMINAL_EVIDENCE_KEYS = [
  ...EVIDENCE_KEYS,
  "facilityType", "terminalPolicy", "providerResultCode", "strictRouteEligible",
  "strictRouteEligibleReason", "installationStatus", "operationalStatus", "statusMeaning",
  "confidence", "providerResponseSha256", "evidenceHash",
];
const TERMINAL_FACILITY_TYPES = ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"];
const TERMINAL_REASON = "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.";
const TERMINAL_TUPLE = { stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro", sourceId: "kric-station-convenience-standard" };
const STATION_LINE_KEYS = ["stationId", "lineId", "operatorId"];

export function materializeStationLineAccessibility(input) {
  const { candidate, observedAt, stationLines, evidenceRows } = validateInput(input);
  const canonicalLines = canonicalStationLines(stationLines);
  const lineIndex = indexStationLines(canonicalLines);
  const evidenceByTarget = indexEvidence(evidenceRows, candidate, observedAt, lineIndex);
  const rows = materializedRows(canonicalLines, candidate, evidenceByTarget, observedAt);
  const stateSummary = summarizeStates(rows);
  const payload = canonicalObject({ candidate, rows, stateSummary });
  return canonicalObject({
    ...payload,
    materializationDigest: sha256(canonicalJson(payload)),
  });
}

function validateInput(input) {
  assertKeys(input, ["candidate", "stationLines", "evidenceRows", "observedAt"], "input keys");
  if (!Array.isArray(input.stationLines) || !Array.isArray(input.evidenceRows)) {
    throw new Error("stationLines and evidenceRows must be arrays");
  }
  return {
    candidate: validateCandidate(input.candidate),
    observedAt: requiredUtcInstant(input.observedAt, "observedAt"),
    stationLines: input.stationLines,
    evidenceRows: input.evidenceRows,
  };
}

function validateCandidate(value) {
  assertKeys(value, ["candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion"], "candidate identity keys");
  const candidate = canonicalObject(value);
  for (const [key, item] of Object.entries(candidate)) assertNonBlank(item, key);
  validateSha256Fields(candidate, ["stationSetSha256", "sourceSetSha256"], "candidate");
  return candidate;
}

function canonicalStationLines(stationLines) {
  return stationLines.map((line) => {
    assertKeys(line, STATION_LINE_KEYS, "station line keys");
    for (const key of STATION_LINE_KEYS) assertNonBlank(line[key], `station line ${key}`);
    return { stationId: line.stationId, lineId: line.lineId, operatorId: line.operatorId };
  }).sort(compareStationLines);
}

function indexStationLines(lines) {
  const byIdentity = new Map();
  const operatorByStationAndLine = new Map();
  for (const line of lines) {
    const key = stationLineKey(line);
    if (byIdentity.has(key)) throw new Error("duplicate canonical station line");
    assertUniqueStationLineOperator(line, operatorByStationAndLine);
    byIdentity.set(key, line);
  }
  return { byIdentity, operatorByStationAndLine };
}

function assertUniqueStationLineOperator(line, operatorByStationAndLine) {
  const key = stationAndLineKey(line);
  const existingOperator = operatorByStationAndLine.get(key);
  if (existingOperator && existingOperator !== line.operatorId) throw new Error("station line identity mismatch");
  operatorByStationAndLine.set(key, line.operatorId);
}

function indexEvidence(evidenceRows, candidate, observedAt, lineIndex) {
  const byTarget = new Map();
  for (const value of evidenceRows) {
    const evidence = validateEvidence(value, candidate, observedAt);
    assertMappedEvidence(evidence, lineIndex);
    addEvidence(byTarget, evidence);
  }
  return byTarget;
}

function assertMappedEvidence(evidence, lineIndex) {
  if (lineIndex.byIdentity.has(stationLineKey(evidence))) return;
  if (lineIndex.operatorByStationAndLine.has(stationAndLineKey(evidence))) {
    throw new Error("station line identity mismatch");
  }
  throw new Error("unmapped evidence row");
}

function addEvidence(byTarget, evidence) {
  const key = `${stationLineKey(evidence)}\u0000${evidence.domain}`;
  const existing = byTarget.get(key);
  if (!existing) return byTarget.set(key, evidence.terminal ? [evidence] : evidence);
  if (Array.isArray(existing) && evidence.terminal) return existing.push(evidence);
  if (canonicalJson(existing) === canonicalJson(evidence)) throw new Error("duplicate evidence row");
  throw new Error("conflicting evidence rows");
}

function materializedRows(lines, candidate, evidenceByTarget, observedAt) {
  return lines.flatMap((line) => [...DOMAINS].sort(compareBytes).map((domain) => {
    const evidence = normalizedEvidence(evidenceByTarget.get(`${stationLineKey(line)}\u0000${domain}`));
    return materializedRow(line, domain, candidate, evidence, observedAt);
  }));
}

function materializedRow(line, domain, candidate, evidence, observedAt) {
  const row = {
    ...candidate,
    stationId: line.stationId,
    lineId: line.lineId,
    operatorId: line.operatorId,
    domain,
    state: evidence ? derivedState(evidence, observedAt) : "MISSING",
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
  };
  if (evidence?.state === "UNVERIFIED_EVIDENCE_BLOCKED") {
    Object.assign(row, {
      terminalPolicy: evidence.terminalPolicy,
      providerResultCode: evidence.providerResultCode,
      providerResponseSha256: evidence.providerResponseSha256,
    });
  }
  return canonicalObject(row);
}

function summarizeStates(rows) {
  const summary = Object.fromEntries([...STATES, ...(rows.some(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED") ? ["UNVERIFIED_EVIDENCE_BLOCKED"] : [])].map((state) => [state, 0]));
  for (const row of rows) summary[row.state] += 1;
  return summary;
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
  const terminal = row?.evidenceKind === "UNVERIFIED_EVIDENCE_BLOCKED";
  assertKeys(row, terminal ? TERMINAL_EVIDENCE_KEYS : EVIDENCE_KEYS, "evidence row keys");
  assertEvidenceIdentity(row, candidate);
  assertEvidenceTextFields(row);
  assertEvidenceState(row);
  const timestamps = normalizedEvidenceTimestamps(row, observedAt);
  return canonicalObject({ ...row, ...timestamps, terminal });
}

function assertEvidenceIdentity(row, candidate) {
  const identities = [
    ["candidateId", "candidate identity mismatch"],
    ["stationSetSha256", "station set identity mismatch"],
    ["sourceSetSha256", "source set identity mismatch"],
    ["mappingContractVersion", "mapping identity mismatch"],
    ["materializerVersion", "materializer identity mismatch"],
  ];
  for (const [key, message] of identities) {
    if (row[key] !== candidate[key]) throw new Error(message);
  }
}

function assertEvidenceTextFields(row) {
  for (const key of ["candidateId", "stationSetSha256", "sourceSetSha256", "stationId", "lineId", "operatorId", "domain", "state", "sourceId", "sourceSnapshotId", "provenanceId", "licenseId", "mappingContractVersion", "materializerVersion", "evidenceKind"]) {
    assertNonBlank(row[key], `evidence ${key}`);
  }
  validateSha256Fields(row, ["stationSetSha256", "sourceSetSha256", "evidenceRawSha256"], "evidence");
  if (row.evidenceKind === "UNVERIFIED_EVIDENCE_BLOCKED") {
    if (row.providerRecordHash !== null) throw new Error("terminal provider record hash must be null");
    validateSha256Fields(row, ["providerResponseSha256", "evidenceHash"], "terminal evidence");
    return;
  }
  validateSha256Fields(row, ["providerRecordHash"], "evidence");
}

function assertEvidenceState(row) {
  if (!DOMAINS.includes(row.domain)) throw new Error("unsupported evidence domain");
  if ((!STATES.includes(row.state) && row.state !== "UNVERIFIED_EVIDENCE_BLOCKED") || row.state === "MISSING" || row.state === "STALE") {
    throw new Error("unsupported admitted evidence state");
  }
  if (row.state === "NOT_APPLICABLE" && (typeof row.evidenceReason !== "string" || row.evidenceReason.trim() === "")) {
    throw new Error("NOT_APPLICABLE evidence reason is required");
  }
  assertNonBlank(row.evidenceReason, "evidence evidenceReason");
  const validKinds = {
    VERIFIED_PRESENT: ["OBSERVED"],
    VERIFIED_ABSENT: ["EXHAUSTIVE_LIST", "EXPLICIT_ZERO"],
    NOT_APPLICABLE: ["CURRENT_APPLICABILITY_RULE"],
    UNKNOWN: [...UNKNOWN_KINDS],
    UNVERIFIED_EVIDENCE_BLOCKED: ["UNVERIFIED_EVIDENCE_BLOCKED"],
  };
  if (!validKinds[row.state].includes(row.evidenceKind)) throw new Error(`${row.state} evidence kind is not allowed`);
  if (row.state === "UNVERIFIED_EVIDENCE_BLOCKED") {
    if (row.domain !== "FACILITY" || row.terminalPolicy !== "EXACT_TUPLE_PROVIDER_RESULT_03"
      || row.providerResultCode !== "03" || row.strictRouteEligible !== false
      || row.strictRouteEligibleReason !== "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED"
      || row.installationStatus !== "UNKNOWN" || row.operationalStatus !== "UNKNOWN"
      || row.statusMeaning !== "PROVIDER_RESULT_UNVERIFIED" || row.confidence !== 0
      || !TERMINAL_FACILITY_TYPES.includes(row.facilityType) || row.evidenceReason !== TERMINAL_REASON) {
      throw new Error("terminal evidence contract mismatch");
    }
    for (const [field, expected] of Object.entries(TERMINAL_TUPLE)) {
      if (row[field] !== expected) throw new Error("terminal evidence tuple mismatch");
    }
    const hashInput = {
      sourceSnapshotId: row.sourceSnapshotId, stationId: row.stationId, lineId: row.lineId,
      operatorId: row.operatorId, facilityType: row.facilityType, terminalPolicy: row.terminalPolicy,
      providerResponseSha256: row.providerResponseSha256,
    };
    if (row.evidenceHash !== sha256(canonicalJson(hashInput))) throw new Error("terminal evidence hash mismatch");
  }
}

function normalizedEvidenceTimestamps(row, observedAt) {
  const capturedAt = requiredUtcInstant(row.capturedAt, "evidence capturedAt");
  const freshUntil = requiredUtcInstant(row.freshUntil, "evidence freshUntil");
  if (capturedAt > observedAt) throw new Error("capturedAt must not be after observedAt");
  if (freshUntil <= capturedAt) throw new Error("freshUntil must be after capturedAt");
  return { capturedAt: new Date(capturedAt).toISOString(), freshUntil: new Date(freshUntil).toISOString() };
}

function derivedState(evidence, observedAt) {
  if (requiredUtcInstant(evidence.freshUntil, "evidence freshUntil") <= observedAt) return "STALE";
  if (UNKNOWN_KINDS.has(evidence.evidenceKind)) return "UNKNOWN";
  return evidence.state;
}

function normalizedEvidence(value) {
  if (!Array.isArray(value)) return value;
  if (value.length !== TERMINAL_FACILITY_TYPES.length) throw new Error("terminal evidence row count mismatch");
  const types = new Set(value.map(({ facilityType }) => facilityType));
  if (types.size !== TERMINAL_FACILITY_TYPES.length || TERMINAL_FACILITY_TYPES.some((type) => !types.has(type))) {
    throw new Error("terminal evidence facility type mismatch");
  }
  const reference = value[0];
  const identity = ["candidateId", "stationSetSha256", "sourceSetSha256", "stationId", "lineId", "operatorId", "domain", "state", "sourceId", "sourceSnapshotId", "evidenceRawSha256", "capturedAt", "freshUntil", "provenanceId", "licenseId", "mappingContractVersion", "materializerVersion", "evidenceKind", "evidenceReason", "terminalPolicy", "providerResultCode", "strictRouteEligible", "strictRouteEligibleReason", "installationStatus", "operationalStatus", "statusMeaning", "confidence", "providerRecordHash", "providerResponseSha256"];
  for (const row of value) {
    if (!row.terminal || identity.some((field) => row[field] !== reference[field])) throw new Error("terminal evidence identity mismatch");
  }
  return reference;
}

function stationLineKey(value) {
  return `${value.stationId}\u0000${value.lineId}\u0000${value.operatorId}`;
}

function stationAndLineKey(value) {
  return `${value.stationId}\u0000${value.lineId}`;
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

function validateSha256Fields(value, fields, label) {
  for (const field of fields) {
    if (!/^[a-f0-9]{64}$/.test(value[field])) throw new Error(`${label} ${field} must be sha256`);
  }
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
