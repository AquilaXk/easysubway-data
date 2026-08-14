import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const CANDIDATE_KEYS = [
  "candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion",
];
const STATION_LINE_KEYS = [
  "stationId", "stationName", "stationAliases", "regionId", "lineId", "lineName", "operatorId", "operatorName",
];
const STATION_LINE_REQUIRED_KEYS = STATION_LINE_KEYS.filter((key) => key !== "stationAliases");
const SOURCE_ADMISSION_KEYS = [
  "schemaVersion", "artifactKind", "candidateId", "sourceId", "snapshotId", "rawSha256",
  "sourceSnapshotSetHash", "stationSetSha256", "stationLineMappingSha256", "queryPlanSha256",
  "coverageScopeSha256", "mappingContractVersion", "decision", "productionUseAllowed", "approvedAt",
  "provenanceId", "licenseId", "providerSnapshotDigest", "providerSnapshotRawSha256",
  "providerCollectionPlanDigest", "providerQueryPlanSha256", "facilityAdmissionDigest",
  "facilityStationLineMappingSha256",
];
const SNAPSHOT_KEYS = [
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "freshUntil",
  "coverage", "queryPlan", "results", "providerSnapshotIdentity",
];
const PROVIDER_SNAPSHOT_IDENTITY_KEYS = [
  "sourceId", "snapshotId", "capturedAt", "freshUntil", "snapshotDigest", "rawSha256",
  "collectionPlanDigest", "queryPlanSha256",
];
const QUERY_KEYS = [
  "queryId", "routeEdgeId", "providerOperatorId", "providerLineId", "providerStationId", "providerNextStationId",
  "operatorName", "lineName", "stationName", "regionId",
];
const RESULT_KEYS = ["queryId", "state", "records", "zeroEvidenceSha256"];
const RECORD_KEYS = ["recordId", "classification", "providerRecordHash"];
const STATES = [
  "ADMITTED_EXIT_PATH",
  "ADMITTED_VERIFIED_ABSENCE",
  "BLOCKED_WITH_EVIDENCE",
  "MISSING",
  "STALE",
  "UNKNOWN",
];
const RESULT_STATES = new Set(["OBSERVED_EXIT_PATH", "EXPLICIT_ZERO", "PROVIDER_NO_DATA", "FAILED"]);
const OUTPUT_KEYS = [
  "schemaVersion", "artifactKind", "candidate", "sourceIdentity", "stationLineMappingSha256",
  "stationLineSetSha256", "normalizedEvidenceSha256", "queryPartition", "cells",
  "materializerEvidenceRows", "stateSummary", "decision", "admissionDigest",
];
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export function buildExitPathAdmission(input) {
  assertKeys(input, [
    "candidate", "observedAt", "sourceAdmission", "sourceSnapshots", "stationLines",
    "stationLineMappingSha256", "stationLineSetSha256", "snapshotBytes",
  ], "EXIT admission input keys");
  const candidate = validateCandidate(input.candidate);
  const observedAt = requiredUtcInstant(input.observedAt, "observedAt");
  const stationLines = validateStationLines(
    input.stationLines,
    candidate.stationSetSha256,
    input.stationLineSetSha256,
    input.stationLineMappingSha256,
  );
  const rawSnapshotBytes = requireBytes(input.snapshotBytes);
  const snapshot = validateSnapshot(parseCanonicalJson(rawSnapshotBytes, "EXIT snapshot"), observedAt);
  if (!rawSnapshotBytes.equals(Buffer.from(canonicalJson(snapshot)))) {
    throw new Error("EXIT snapshot arrays must use canonical byte order");
  }
  const rawSha256 = sha256(rawSnapshotBytes);
  validateSourceSnapshotSet(input.sourceSnapshots, candidate.sourceSetSha256);
  const sourceAdmission = validateSourceAdmission({
    value: input.sourceAdmission,
    candidate,
    snapshot,
    rawSha256,
    observedAt,
    stationLineMappingSha256: input.stationLineMappingSha256,
  });
  const queryPartition = partitionQueries(snapshot.queryPlan, stationLines);
  const resultByQuery = new Map(snapshot.results.map((result) => [result.queryId, result]));
  const joinedByStationLine = indexJoinedQueries(queryPartition.joined);
  const normalizedEvidenceSha256 = sha256(canonicalJson({
    coverage: snapshot.coverage,
    queryPlan: snapshot.queryPlan,
    results: snapshot.results,
  }));
  const sourceIdentity = canonicalObject({
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    rawSha256,
    capturedAt: snapshot.capturedAt,
    freshUntil: snapshot.freshUntil,
    queryPlanSha256: sourceAdmission.queryPlanSha256,
    coverageScopeSha256: sourceAdmission.coverageScopeSha256,
    approvedAt: sourceAdmission.approvedAt,
    decision: sourceAdmission.decision,
    productionUseAllowed: sourceAdmission.productionUseAllowed,
    provenanceId: sourceAdmission.provenanceId,
    licenseId: sourceAdmission.licenseId,
    providerSnapshotDigest: sourceAdmission.providerSnapshotDigest,
    providerSnapshotRawSha256: sourceAdmission.providerSnapshotRawSha256,
    providerCollectionPlanDigest: sourceAdmission.providerCollectionPlanDigest,
    providerQueryPlanSha256: sourceAdmission.providerQueryPlanSha256,
    facilityAdmissionDigest: sourceAdmission.facilityAdmissionDigest,
    facilityStationLineMappingSha256: sourceAdmission.facilityStationLineMappingSha256,
  });
  const cells = stationLines.map((stationLine) => buildCell({
    candidate,
    stationLine,
    stationLineMappingSha256: input.stationLineMappingSha256,
    stationLineSetSha256: input.stationLineSetSha256,
    joined: joinedByStationLine.get(stationLineKey(stationLine)),
    resultByQuery,
    snapshot,
    sourceAdmission,
    rawSha256,
    normalizedEvidenceSha256,
    observedAt,
  }));
  const materializerEvidenceRows = cells
    .filter(({ state }) => state === "ADMITTED_EXIT_PATH" || state === "ADMITTED_VERIFIED_ABSENCE")
    .map(materializerEvidenceRow);
  const stateSummary = Object.fromEntries(STATES.map((state) => [
    state, cells.filter((cell) => cell.state === state).length,
  ]));
  const decision = snapshot.coverage.exhaustive === true
    && queryPartition.unmatched.length === 0
    && queryPartition.ambiguous.length === 0
    && cells.length > 0
    && cells.every(({ state }) => state === "ADMITTED_EXIT_PATH" || state === "ADMITTED_VERIFIED_ABSENCE")
    ? "GO"
    : "NO_GO";
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "exit-path-admission-matrix",
    candidate,
    sourceIdentity,
    stationLineMappingSha256: input.stationLineMappingSha256,
    stationLineSetSha256: input.stationLineSetSha256,
    normalizedEvidenceSha256,
    queryPartition,
    cells,
    materializerEvidenceRows,
    stateSummary,
    decision,
  });
  return canonicalObject({ ...payload, admissionDigest: sha256(canonicalJson(payload)) });
}

export function canonicalExitPathAdmissionJson(result) {
  assertKeys(result, OUTPUT_KEYS, "EXIT admission output keys");
  const { admissionDigest, ...payload } = result;
  assertSha256(admissionDigest, "EXIT admission digest");
  if (sha256(canonicalJson(payload)) !== admissionDigest) throw new Error("EXIT admission digest mismatch");
  return canonicalJson(result);
}

function validateCandidate(value) {
  assertKeys(value, CANDIDATE_KEYS, "candidate identity keys");
  for (const key of CANDIDATE_KEYS) assertNonBlank(value[key], `candidate ${key}`);
  for (const key of ["stationSetSha256", "sourceSetSha256"]) assertSha256(value[key], `candidate ${key}`);
  return canonicalObject(value);
}

function validateStationLines(value, expectedStationSet, expectedStationLineSet, expectedMapping) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("stationLines must be a non-empty array");
  assertSha256(expectedStationLineSet, "stationLineSetSha256");
  assertSha256(expectedMapping, "stationLineMappingSha256");
  const lines = value.map(normalizeStationLine).toSorted(compareStationLines);
  const seen = new Set();
  for (const line of lines) {
    const key = stationLineKey(line);
    if (seen.has(key)) throw new Error("duplicate canonical station line");
    seen.add(key);
  }
  const stationIds = [...new Set(lines.map(({ stationId }) => stationId))].sort(compareBytes);
  if (sha256(canonicalJson(stationIds)) !== expectedStationSet) throw new Error("station set identity mismatch");
  const stationLineSet = lines.map(({ stationId, lineId, operatorId }) => canonicalObject({
    stationId, lineId, operatorId,
  }));
  if (sha256(canonicalJson(stationLineSet)) !== expectedStationLineSet) {
    throw new Error("station-line denominator identity mismatch");
  }
  if (sha256(canonicalJson(lines)) !== expectedMapping) throw new Error("station-line mapping identity mismatch");
  return lines;
}

function normalizeStationLine(line) {
  assertKeys(line, STATION_LINE_KEYS, "station line keys");
  for (const key of STATION_LINE_REQUIRED_KEYS) assertNonBlank(line[key], `station line ${key}`);
  if (!Array.isArray(line.stationAliases)) throw new Error("station line aliases must be non-blank strings");
  for (const alias of line.stationAliases) {
    if (typeof alias !== "string" || alias.trim() === "") {
      throw new Error("station line aliases must be non-blank strings");
    }
  }
  const stationAliases = [...new Set(line.stationAliases)].toSorted(compareBytes);
  return canonicalObject({ ...line, stationAliases });
}

function validateSnapshot(value, observedAt) {
  assertKeys(value, SNAPSHOT_KEYS, "EXIT snapshot keys");
  if (value.schemaVersion !== 3 || value.artifactKind !== "exit-path-normalized-source-snapshot") {
    throw new Error("EXIT snapshot schema mismatch");
  }
  for (const key of ["sourceId", "snapshotId"]) assertNonBlank(value[key], `EXIT snapshot ${key}`);
  const capturedAt = requiredUtcInstant(value.capturedAt, "EXIT snapshot capturedAt");
  const freshUntil = requiredUtcInstant(value.freshUntil, "EXIT snapshot freshUntil");
  if (capturedAt > observedAt) throw new Error("EXIT snapshot is future-dated");
  if (freshUntil <= capturedAt) throw new Error("EXIT snapshot freshness interval is invalid");
  const providerSnapshotIdentity = validateProviderSnapshotIdentity(
    value.providerSnapshotIdentity, value, capturedAt, freshUntil,
  );
  assertKeys(value.coverage, ["exhaustive", "queryIds"], "EXIT snapshot coverage keys");
  if (typeof value.coverage.exhaustive !== "boolean") throw new Error("EXIT snapshot coverage exhaustive must be boolean");
  const queryPlan = validateQueryPlan(value.queryPlan);
  const queryIds = validateUniqueStrings(value.coverage.queryIds, "EXIT snapshot coverage queryIds");
  const plannedIds = new Set(queryPlan.map(({ queryId }) => queryId));
  if (queryIds.some((queryId) => !plannedIds.has(queryId))) throw new Error("EXIT snapshot coverage query mismatch");
  if (value.coverage.exhaustive && queryIds.length !== plannedIds.size) {
    throw new Error("EXIT snapshot exhaustive coverage is incomplete");
  }
  const results = validateResults(value.results, plannedIds);
  const orderedQueryIds = queryIds.toSorted(compareBytes);
  const orderedQueryPlan = queryPlan.toSorted(compareQueries);
  const orderedResults = results.toSorted(compareResults);
  return canonicalObject({
    ...value,
    capturedAt: new Date(capturedAt).toISOString(),
    freshUntil: new Date(freshUntil).toISOString(),
    providerSnapshotIdentity,
    coverage: canonicalObject({ exhaustive: value.coverage.exhaustive, queryIds: orderedQueryIds }),
    queryPlan: orderedQueryPlan,
    results: orderedResults,
  });
}

function validateProviderSnapshotIdentity(value, snapshot, capturedAt, freshUntil) {
  assertKeys(value, PROVIDER_SNAPSHOT_IDENTITY_KEYS, "EXIT provider snapshot identity keys");
  for (const key of ["sourceId", "snapshotId"]) {
    assertNonBlank(value[key], `EXIT provider snapshot ${key}`);
  }
  for (const key of ["snapshotDigest", "rawSha256", "collectionPlanDigest", "queryPlanSha256"]) {
    assertSha256(value[key], `EXIT provider snapshot ${key}`);
  }
  const providerCapturedAt = requiredUtcInstant(value.capturedAt, "EXIT provider snapshot capturedAt");
  const providerFreshUntil = requiredUtcInstant(value.freshUntil, "EXIT provider snapshot freshUntil");
  if (value.sourceId !== snapshot.sourceId || value.snapshotId !== snapshot.snapshotId
    || providerCapturedAt !== capturedAt || providerFreshUntil !== freshUntil) {
    throw new Error("EXIT provider snapshot identity mismatch");
  }
  return canonicalObject({
    ...value,
    capturedAt: new Date(providerCapturedAt).toISOString(),
    freshUntil: new Date(providerFreshUntil).toISOString(),
  });
}

function validateQueryPlan(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("EXIT snapshot queryPlan must be non-empty");
  const seenIds = new Set();
  const seenProviderTuples = new Set();
  return value.map((query) => {
    assertKeys(query, QUERY_KEYS, "EXIT query keys");
    for (const key of QUERY_KEYS) assertNonBlank(query[key], `EXIT query ${key}`);
    if (seenIds.has(query.queryId)) throw new Error("duplicate EXIT queryId");
    seenIds.add(query.queryId);
    const providerTuple = [
      query.providerOperatorId, query.providerLineId, query.providerStationId, query.providerNextStationId,
    ].join("\0");
    if (seenProviderTuples.has(providerTuple)) throw new Error("duplicate EXIT provider query tuple");
    seenProviderTuples.add(providerTuple);
    return canonicalObject(query);
  });
}

function validateResults(value, plannedIds) {
  if (!Array.isArray(value)) throw new Error("EXIT snapshot results must be an array");
  const seen = new Set();
  return value.map((result) => {
    assertKeys(result, RESULT_KEYS, "EXIT result keys");
    assertNonBlank(result.queryId, "EXIT result queryId");
    if (!plannedIds.has(result.queryId)) throw new Error("EXIT result references unknown query");
    if (seen.has(result.queryId)) throw new Error("duplicate EXIT query result");
    seen.add(result.queryId);
    if (!RESULT_STATES.has(result.state)) throw new Error("unsupported EXIT result state");
    if (!Array.isArray(result.records)) throw new Error("EXIT result records must be an array");
    const records = result.records.map(validateRecord).sort(compareRecords);
    const recordIds = new Set();
    for (const record of records) {
      if (recordIds.has(record.recordId)) throw new Error("duplicate EXIT record");
      recordIds.add(record.recordId);
    }
    if (result.state === "OBSERVED_EXIT_PATH") {
      if (records.length === 0 || result.zeroEvidenceSha256 !== null) {
        throw new Error("observed EXIT path result shape mismatch");
      }
    } else if (result.state === "EXPLICIT_ZERO") {
      if (records.length !== 0) throw new Error("explicit zero EXIT result must not contain records");
      assertSha256(result.zeroEvidenceSha256, "explicit zero EXIT evidence");
    } else if (records.length !== 0 || result.zeroEvidenceSha256 !== null) {
      throw new Error("non-success EXIT result shape mismatch");
    }
    return canonicalObject({ ...result, records });
  });
}

function validateRecord(record) {
  assertKeys(record, RECORD_KEYS, "EXIT record keys");
  assertNonBlank(record.recordId, "EXIT record recordId");
  if (record.classification !== "EXIT_TO_PLATFORM_PATH") throw new Error("EXIT record classification mismatch");
  assertSha256(record.providerRecordHash, "EXIT record providerRecordHash");
  const payload = canonicalObject({ recordId: record.recordId, classification: record.classification });
  if (sha256(canonicalJson(payload)) !== record.providerRecordHash) throw new Error("EXIT record hash mismatch");
  return canonicalObject(record);
}

function validateSourceSnapshotSet(value, expectedHash) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("sourceSnapshots must be a non-empty array");
  if (sha256(JSON.stringify(value)) !== expectedHash) throw new Error("source snapshot set identity mismatch");
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("source snapshot entry mismatch");
    }
    for (const key of ["sourceId", "snapshotId"]) assertNonBlank(entry[key], `source snapshot ${key}`);
    assertSha256(entry.rawSha256, "source snapshot rawSha256");
    const key = `${entry.sourceId}\0${entry.snapshotId}`;
    if (seen.has(key)) throw new Error("duplicate source snapshot identity");
    seen.add(key);
  }
}

function validateSourceAdmission({
  value, candidate, snapshot, rawSha256, observedAt, stationLineMappingSha256,
}) {
  assertKeys(value, SOURCE_ADMISSION_KEYS, "EXIT source admission keys");
  if (value.schemaVersion !== 1 || value.artifactKind !== "exit-path-source-admission") {
    throw new Error("EXIT source admission schema mismatch");
  }
  for (const key of [
    "candidateId", "sourceId", "snapshotId", "mappingContractVersion", "decision", "approvedAt",
  ]) assertNonBlank(value[key], `EXIT source admission ${key}`);
  for (const key of [
    "rawSha256", "sourceSnapshotSetHash", "stationSetSha256", "stationLineMappingSha256",
    "queryPlanSha256", "coverageScopeSha256", "provenanceId", "licenseId",
    "providerSnapshotDigest", "providerSnapshotRawSha256", "providerCollectionPlanDigest",
    "providerQueryPlanSha256", "facilityAdmissionDigest", "facilityStationLineMappingSha256",
  ]) assertSha256(value[key], `EXIT source admission ${key}`);
  if (!new Set(["APPROVED", "BLOCKED"]).has(value.decision)
    || typeof value.productionUseAllowed !== "boolean") {
    throw new Error("EXIT source admission decision mismatch");
  }
  const approvedAt = requiredUtcInstant(value.approvedAt, "EXIT source admission approvedAt");
  if (approvedAt < requiredUtcInstant(snapshot.capturedAt, "EXIT snapshot capturedAt") || approvedAt > observedAt) {
    throw new Error("EXIT source admission approval time mismatch");
  }
  const identities = [
    [value.candidateId, candidate.candidateId],
    [value.sourceId, snapshot.sourceId],
    [value.snapshotId, snapshot.snapshotId],
    [value.rawSha256, rawSha256],
    [value.sourceSnapshotSetHash, candidate.sourceSetSha256],
    [value.stationSetSha256, candidate.stationSetSha256],
    [value.stationLineMappingSha256, stationLineMappingSha256],
    [value.queryPlanSha256, sha256(canonicalJson(snapshot.queryPlan))],
    [value.coverageScopeSha256, sha256(canonicalJson(snapshot.coverage))],
    [value.mappingContractVersion, candidate.mappingContractVersion],
    [value.providerSnapshotDigest, snapshot.providerSnapshotIdentity.snapshotDigest],
    [value.providerSnapshotRawSha256, snapshot.providerSnapshotIdentity.rawSha256],
    [value.providerCollectionPlanDigest, snapshot.providerSnapshotIdentity.collectionPlanDigest],
    [value.providerQueryPlanSha256, snapshot.providerSnapshotIdentity.queryPlanSha256],
  ];
  if (identities.some(([actual, expected]) => actual !== expected)) {
    throw new Error("EXIT source admission identity mismatch");
  }
  return canonicalObject({ ...value, approvedAt: new Date(approvedAt).toISOString() });
}

function partitionQueries(queryPlan, stationLines) {
  const joined = [];
  const unmatched = [];
  const ambiguous = [];
  for (const query of queryPlan) {
    const matches = stationLines.filter((line) => line.operatorName === query.operatorName
      && line.lineName === query.lineName
      && line.stationName === query.stationName
      && line.regionId === query.regionId);
    if (matches.length === 1) {
      joined.push(canonicalObject({ ...query, stationLineId: `${matches[0].stationId}:${matches[0].lineId}` }));
    } else if (matches.length === 0) {
      unmatched.push(canonicalObject({ ...query, reason: "CANONICAL_STATION_LINE_UNMATCHED" }));
    } else {
      ambiguous.push(canonicalObject({
        ...query,
        reason: "CANONICAL_STATION_LINE_AMBIGUOUS",
        candidateStationLineIds: matches.map(({ stationId, lineId }) => `${stationId}:${lineId}`).sort(compareBytes),
      }));
    }
  }
  joined.sort(compareQueries);
  unmatched.sort(compareQueries);
  ambiguous.sort(compareQueries);
  return canonicalObject({
    summary: {
      queryCount: queryPlan.length,
      joinedCount: joined.length,
      unmatchedCount: unmatched.length,
      ambiguousCount: ambiguous.length,
    },
    joined,
    unmatched,
    ambiguous,
  });
}

function indexJoinedQueries(joined) {
  const result = new Map();
  for (const query of joined) {
    if (!result.has(query.stationLineId)) result.set(query.stationLineId, []);
    result.get(query.stationLineId).push(query);
  }
  for (const queries of result.values()) queries.sort(compareQueries);
  return result;
}

function buildCell({
  candidate,
  stationLine,
  stationLineMappingSha256,
  stationLineSetSha256,
  joined,
  resultByQuery,
  snapshot,
  sourceAdmission,
  rawSha256,
  normalizedEvidenceSha256,
  observedAt,
}) {
  const base = {
    candidateId: candidate.candidateId,
    stationSetSha256: candidate.stationSetSha256,
    sourceSetSha256: candidate.sourceSetSha256,
    stationLineMappingSha256,
    stationLineSetSha256,
    stationLineId: `${stationLine.stationId}:${stationLine.lineId}`,
    stationId: stationLine.stationId,
    lineId: stationLine.lineId,
    operatorId: stationLine.operatorId,
    domain: "EXIT",
    sourceId: snapshot.sourceId,
    sourceSnapshotId: snapshot.snapshotId,
    evidenceRawSha256: rawSha256,
    capturedAt: snapshot.capturedAt,
    freshUntil: snapshot.freshUntil,
    provenanceId: sourceAdmission.provenanceId,
    licenseId: sourceAdmission.licenseId,
    mappingContractVersion: candidate.mappingContractVersion,
    materializerVersion: candidate.materializerVersion,
    normalizedEvidenceSha256,
  };
  const outcome = resolveCellOutcome({
    stationLineId: base.stationLineId,
    joined,
    resultByQuery,
    snapshot,
    sourceAdmission,
    observedAt,
  });
  return canonicalObject({ ...base, ...outcome });
}

function resolveCellOutcome({
  stationLineId, joined, resultByQuery, snapshot, sourceAdmission, observedAt,
}) {
  const missingHash = sha256(canonicalJson({ stationLineId, state: "MISSING" }));
  if (requiredUtcInstant(snapshot.freshUntil, "EXIT snapshot freshUntil") <= observedAt) {
    return cellOutcome("STALE", "OFFICIAL_EXIT_SOURCE_STALE", missingHash);
  }
  if (!joined) return cellOutcome("MISSING", "OFFICIAL_EXIT_EVIDENCE_MISSING", missingHash);
  if (sourceAdmission.decision !== "APPROVED" || sourceAdmission.productionUseAllowed !== true) {
    return cellOutcome("BLOCKED_WITH_EVIDENCE", "SOURCE_NOT_PRODUCTION_ADMITTED", missingHash);
  }
  if (joined.some(({ queryId }) => !snapshot.coverage.queryIds.includes(queryId))) {
    return cellOutcome("BLOCKED_WITH_EVIDENCE", "SOURCE_COVERAGE_PARTIAL", missingHash);
  }
  const results = joined.map(({ queryId }) => resultByQuery.get(queryId));
  if (results.some((result) => result == null)) {
    return cellOutcome("MISSING", "OFFICIAL_EXIT_RESULT_MISSING", missingHash);
  }
  const resultHash = sha256(canonicalJson(results));
  if (results.some(({ state }) => state === "FAILED")) {
    return cellOutcome("BLOCKED_WITH_EVIDENCE", "PROVIDER_REQUEST_FAILED", resultHash);
  }
  if (results.some(({ state }) => state === "OBSERVED_EXIT_PATH")) {
    return cellOutcome("ADMITTED_EXIT_PATH", "OFFICIAL_EXIT_PATH_PRESENT", resultHash);
  }
  if (results.some(({ state }) => state === "PROVIDER_NO_DATA")) {
    return cellOutcome("UNKNOWN", "PROVIDER_NO_DATA_IS_NOT_ABSENCE", resultHash);
  }
  if (results.every(({ state }) => state === "EXPLICIT_ZERO")) {
    return snapshot.coverage.exhaustive
      ? cellOutcome("ADMITTED_VERIFIED_ABSENCE", "OFFICIAL_EXIT_EXPLICIT_ZERO", resultHash)
      : cellOutcome("BLOCKED_WITH_EVIDENCE", "SOURCE_COVERAGE_PARTIAL", resultHash);
  }
  throw new Error("unsupported EXIT station-line result aggregation");
}

function cellOutcome(state, admissionReason, providerRecordHash) {
  return { state, admissionReason, providerRecordHash };
}

function materializerEvidenceRow(cell) {
  const present = cell.state === "ADMITTED_EXIT_PATH";
  return canonicalObject({
    candidateId: cell.candidateId,
    stationSetSha256: cell.stationSetSha256,
    sourceSetSha256: cell.sourceSetSha256,
    stationId: cell.stationId,
    lineId: cell.lineId,
    operatorId: cell.operatorId,
    domain: "EXIT",
    state: present ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
    sourceId: cell.sourceId,
    sourceSnapshotId: cell.sourceSnapshotId,
    evidenceRawSha256: cell.evidenceRawSha256,
    providerRecordHash: cell.providerRecordHash,
    capturedAt: cell.capturedAt,
    freshUntil: cell.freshUntil,
    provenanceId: cell.provenanceId,
    licenseId: cell.licenseId,
    mappingContractVersion: cell.mappingContractVersion,
    materializerVersion: cell.materializerVersion,
    evidenceKind: present ? "OBSERVED" : "EXPLICIT_ZERO",
    evidenceReason: cell.admissionReason,
  });
}

function parseCanonicalJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(strictUtf8.decode(bytes));
  } catch {
    throw new Error(`${label} must be strict UTF-8 JSON`);
  }
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalJson(value)))) {
    throw new Error(`${label} must be canonical JSON`);
  }
  return value;
}

function requireBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error("snapshotBytes must be non-empty bytes");
  }
  return Buffer.from(value);
}

function validateUniqueStrings(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  for (const entry of value) {
    assertNonBlank(entry, label);
    if (seen.has(entry)) throw new Error(`${label} must be unique`);
    seen.add(entry);
  }
  return [...value];
}

function stationLineKey(value) {
  return `${value.stationId}:${value.lineId}`;
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareQueries(left, right) {
  return compareBytes(left.providerStationId, right.providerStationId)
    || compareBytes(left.providerNextStationId, right.providerNextStationId)
    || compareBytes(left.routeEdgeId, right.routeEdgeId)
    || compareBytes(left.queryId, right.queryId);
}

function compareResults(left, right) {
  return compareBytes(left.queryId, right.queryId);
}

function compareRecords(left, right) {
  return compareBytes(left.recordId, right.recordId);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  const wanted = new Set(expected);
  if (actual.length !== wanted.size || actual.some((key) => !wanted.has(key))) {
    throw new Error(`${label} mismatch`);
  }
}

function assertNonBlank(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-blank string`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be sha256`);
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value).toSorted(([left], [right]) => compareBytes(left, right));
  return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalObject(entry)]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
