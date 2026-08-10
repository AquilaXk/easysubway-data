import { createHash } from "node:crypto";

import { partitionMolitTransferTuples } from "./build-accessibility-source-coverage-report.mjs";
import { validateKricProviderCodeCatalogIdentity } from "./build-molit-nationwide-fixture.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const CANDIDATE_KEYS = [
  "candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion",
];
const STATION_LINE_KEYS = [
  "stationId", "stationName", "stationAliases", "regionId", "lineId", "lineName", "operatorId", "operatorName",
];
const STATES = [
  "ADMITTED_NOT_APPLICABLE",
  "ADMITTED_TRANSFER_TOPOLOGY",
  "BLOCKED_WITH_EVIDENCE",
  "MISSING",
  "STALE",
  "UNKNOWN",
];
const OUTPUT_KEYS = [
  "schemaVersion", "artifactKind", "candidate", "topologySourceIdentity", "topologySourceIdentitySha256",
  "stationLineSetSha256", "normalizedEvidenceSha256", "cells", "tuplePartition", "materializerEvidenceRows", "stateSummary",
  "decision", "admissionDigest",
];

export function buildTransferTopologyAdmission(input) {
  assertKeys(input, [
    "candidate", "observedAt", "providerCodeCatalog", "snapshot", "source", "sourceSnapshots",
    "stationLines", "stationLineSetSha256",
  ], "transfer topology input keys");
  const candidate = validateCandidate(input.candidate);
  const stationLines = validateStationLines(
    input.stationLines, candidate.stationSetSha256, input.stationLineSetSha256,
  );
  const observedAtMillis = requiredUtcInstant(input.observedAt, "observedAt");
  const source = validateSourceAndSnapshot(input.source, input.snapshot, observedAtMillis, candidate);
  validateSourceSnapshotSet(input.sourceSnapshots, candidate.sourceSetSha256, input.snapshot);
  validateKricProviderCodeCatalogIdentity(input.providerCodeCatalog);
  const partition = bindProviderEvidence(enforceExactStationNameMatches(partitionMolitTransferTuples({
    artifacts: [{
      artifactId: candidate.candidateId,
      stationLines: stationLines.map((stationLine) => ({ ...stationLine, stationAliases: [] })),
    }],
    rows: input.snapshot.rows,
    providerCodeCatalog: input.providerCodeCatalog,
  })), input.snapshot.rows);
  const normalizedEvidenceSha256 = sha256(canonicalJson(partition));
  const topologySourceIdentity = canonicalObject({
    sourceId: input.snapshot.sourceId,
    snapshotId: input.snapshot.snapshotId,
    rawSha256: input.snapshot.rawSha256,
    gzipSha256: input.snapshot.gzipSha256,
    metadataFileSha256: input.snapshot.metadataFileSha256,
    sourceInventoryFileSha256: input.snapshot.sourceInventoryFileSha256,
    sourceInventorySha256: input.snapshot.sourceInventorySha256,
    candidateBuildSpecSourceInventorySha256: input.snapshot.candidateBuildSpecSourceInventorySha256,
    sortedContentSha256: input.snapshot.metadata.sortedContentSha256,
    rowCount: input.snapshot.rowCount,
    capturedAt: source.capturedAt,
    freshUntil: source.freshUntil,
    provenanceId: source.provenanceId,
    licenseId: source.licenseId,
  });
  const topologySourceIdentitySha256 = sha256(canonicalJson(topologySourceIdentity));
  const joinedByStationLine = indexJoinedMappings(partition.joined);
  const cells = stationLines.map((stationLine) => buildCell({
    candidate,
    stationLine,
    stationLineSetSha256: input.stationLineSetSha256,
    joined: joinedByStationLine.get(stationLineKey(stationLine)),
    source,
    snapshot: input.snapshot,
    normalizedEvidenceSha256,
    topologySourceIdentitySha256,
  }));
  const materializerEvidenceRows = cells
    .filter(({ state }) => state === "ADMITTED_TRANSFER_TOPOLOGY")
    .map(materializerEvidenceRow);
  const stateSummary = Object.fromEntries(STATES.map((state) => [
    state, cells.filter((cell) => cell.state === state).length,
  ]));
  const decision = cells.length > 0
    && cells.every(({ state }) => state === "ADMITTED_TRANSFER_TOPOLOGY" || state === "ADMITTED_NOT_APPLICABLE")
    && partition.unmatched.length === 0
    && partition.ambiguous.length === 0
    ? "GO"
    : "NO_GO";
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "transfer-topology-admission-matrix",
    candidate,
    stationLineSetSha256: input.stationLineSetSha256,
    topologySourceIdentity,
    topologySourceIdentitySha256,
    normalizedEvidenceSha256,
    cells,
    tuplePartition: partition,
    materializerEvidenceRows,
    stateSummary,
    decision,
  });
  return canonicalObject({ ...payload, admissionDigest: sha256(canonicalJson(payload)) });
}

export function canonicalTransferTopologyAdmissionJson(result) {
  assertKeys(result, OUTPUT_KEYS, "transfer topology admission keys");
  const { admissionDigest, ...payload } = result;
  if (!isSha256(admissionDigest) || sha256(canonicalJson(payload)) !== admissionDigest) {
    throw new Error("transfer topology admission digest mismatch");
  }
  return canonicalJson(result);
}

function validateCandidate(value) {
  assertKeys(value, CANDIDATE_KEYS, "candidate identity keys");
  for (const key of CANDIDATE_KEYS) assertNonBlank(value[key], `candidate ${key}`);
  for (const key of ["stationSetSha256", "sourceSetSha256"]) assertSha256(value[key], `candidate ${key}`);
  return canonicalObject(value);
}

function validateStationLines(value, expectedStationSetSha256, expectedStationLineSetSha256) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("stationLines must be a non-empty array");
  assertSha256(expectedStationLineSetSha256, "stationLineSetSha256");
  const lines = value.map((line) => {
    assertKeys(line, STATION_LINE_KEYS, "station line keys");
    for (const key of STATION_LINE_KEYS.filter((key) => key !== "stationAliases")) {
      assertNonBlank(line[key], `station line ${key}`);
    }
    if (!Array.isArray(line.stationAliases)
      || line.stationAliases.some((alias) => typeof alias !== "string" || alias.trim() === "")) {
      throw new Error("station line aliases must be non-blank strings");
    }
    return canonicalObject({ ...line, stationAliases: [...new Set(line.stationAliases)].sort(compareBytes) });
  }).sort(compareStationLines);
  const seen = new Map();
  for (const line of lines) {
    const key = `${line.stationId}\u0000${line.lineId}`;
    if (seen.has(key)) throw new Error("duplicate canonical station line");
    seen.set(key, line.operatorId);
  }
  const stationIds = [...new Set(lines.map(({ stationId }) => stationId))].sort(compareBytes);
  if (sha256(canonicalJson(stationIds)) !== expectedStationSetSha256) {
    throw new Error("station set identity mismatch");
  }
  const stationLineSet = lines.map(({ stationId, lineId, operatorId }) => canonicalObject({
    stationId, lineId, operatorId,
  }));
  if (sha256(canonicalJson(stationLineSet)) !== expectedStationLineSetSha256) {
    throw new Error("station-line denominator identity mismatch");
  }
  return lines;
}

function validateSourceSnapshotSet(sourceSnapshots, expectedSourceSetSha256, snapshot) {
  if (!Array.isArray(sourceSnapshots) || sourceSnapshots.length === 0) {
    throw new Error("sourceSnapshots must be a non-empty array");
  }
  if (sha256(JSON.stringify(sourceSnapshots)) !== expectedSourceSetSha256) {
    throw new Error("source snapshot set identity mismatch");
  }
  let matched = 0;
  for (const entry of sourceSnapshots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("source snapshot set entry must be an object");
    }
    for (const key of ["sourceId", "snapshotId"]) assertNonBlank(entry[key], `source snapshot ${key}`);
    assertSha256(entry.rawSha256, "source snapshot rawSha256");
    if (entry.sourceId === snapshot.sourceId
      && entry.snapshotId === snapshot.snapshotId
      && entry.rawSha256 === snapshot.rawSha256) matched += 1;
  }
  if (matched !== 1) throw new Error("source snapshot membership mismatch");
}

function validateSourceAndSnapshot(source, snapshot, observedAtMillis, candidate) {
  if (!source || typeof source !== "object" || Array.isArray(source)
    || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("source and snapshot must be objects");
  }
  for (const key of ["id", "owner", "provider", "providerDepartment", "sourceSystem", "datasetUrl", "datasetKind"]) {
    assertNonBlank(source[key], `source ${key}`);
  }
  if (typeof source.productionUseAllowed !== "boolean"
    || typeof source.capabilities?.facility?.productionUseAllowed !== "boolean") {
    throw new Error("source production admission flags must be booleans");
  }
  if (source.id !== snapshot.sourceId
    || snapshot.sourceInventorySha256 !== snapshot.candidateBuildSpecSourceInventorySha256) {
    throw new Error("source snapshot identity mismatch");
  }
  for (const key of [
    "rawSha256", "gzipSha256", "metadataFileSha256", "sourceInventoryFileSha256",
    "sourceInventorySha256", "candidateBuildSpecSourceInventorySha256",
  ]) assertSha256(snapshot[key], `snapshot ${key}`);
  if (!Array.isArray(snapshot.rows) || !Number.isInteger(snapshot.rowCount)
    || snapshot.rowCount < 0 || snapshot.rows.length !== snapshot.rowCount) {
    throw new Error("source snapshot row count mismatch");
  }
  validateSnapshotMetadata(snapshot);
  const rawSnapshotSource = source.rawSnapshotAdmission !== undefined;
  if (rawSnapshotSource) validateRawSnapshotAdmission(source, snapshot);
  else validateProductionAdmissionEvidence(source, snapshot, candidate);
  const capturedAtMillis = requiredUtcInstant(snapshot.capturedAt, "snapshot capturedAt");
  const freshUntilMillis = requiredUtcInstant(snapshot.freshUntil, "snapshot freshUntil");
  if (capturedAtMillis > observedAtMillis) throw new Error("source snapshot is future-dated");
  if (freshUntilMillis <= capturedAtMillis) throw new Error("source snapshot freshness interval is invalid");
  const license = source.license;
  if (!license || typeof license !== "object" || Array.isArray(license)) throw new Error("source license is required");
  for (const key of ["type", "name", "attribution", "evidenceUrl"]) assertNonBlank(license[key], `license ${key}`);
  for (const key of ["commercialUseAllowed", "derivativeWorkAllowed", "redistributionAllowed"]) {
    if (typeof license[key] !== "boolean") throw new Error(`license ${key} must be boolean`);
  }
  const provenance = Object.fromEntries([
    "id", "owner", "provider", "providerDepartment", "sourceSystem", "datasetUrl", "datasetKind",
  ].map((key) => [key, source[key]]));
  return {
    capturedAt: new Date(capturedAtMillis).toISOString(),
    freshUntil: new Date(freshUntilMillis).toISOString(),
    stale: observedAtMillis >= freshUntilMillis,
    productionAdmitted: !rawSnapshotSource
      && source.productionUseAllowed === true
      && source.capabilities.facility.status === "SUPPORTED"
      && source.capabilities.facility.productionUseAllowed === true
      && source.capabilities.facility.coverageStatus === "SOURCE_INVENTORY_COVERED"
      && license.redistributionAllowed === true,
    provenanceId: sha256(canonicalJson(provenance)),
    licenseId: sha256(canonicalJson(license)),
  };
}

function validateRawSnapshotAdmission(source, snapshot) {
  const admission = source.rawSnapshotAdmission;
  if (!admission || admission.status !== "LOCKED"
    || source.coverageScope?.mappingStatus !== "UNMAPPED_RAW_SNAPSHOT"
    || admission.snapshotId !== snapshot.snapshotId
    || admission.metadataFileSha256 !== snapshot.metadataFileSha256
    || admission.rawSha256 !== snapshot.rawSha256
    || admission.gzipSha256 !== snapshot.gzipSha256
    || admission.rowCount !== snapshot.rowCount) {
    throw new Error("source snapshot identity mismatch");
  }
}

function validateProductionAdmissionEvidence(source, snapshot, candidate) {
  const evidence = source.admissionEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || source.coverageScope?.mappingStatus !== undefined
    || evidence.artifactKind !== "source-admission-pipeline-evidence-summary"
    || evidence.candidateId !== candidate.candidateId
    || evidence.sourceId !== source.id
    || evidence.snapshotId !== snapshot.snapshotId
    || evidence.decision !== "APPROVED"
    || evidence.rawSha256 !== snapshot.rawSha256
    || evidence.sourceSnapshotSetHash !== candidate.sourceSetSha256
    || evidence.sourceInventorySha256 !== snapshot.sourceInventorySha256
    || !Number.isInteger(evidence.issue) || evidence.issue < 1
    || !Number.isInteger(evidence.admissionDurationSeconds) || evidence.admissionDurationSeconds < 0
    || evidence.quotaEvidence?.productionUseAllowed !== true) {
    throw new Error("production admission evidence mismatch");
  }
  for (const key of ["approvedBy", "approvedAt"]) {
    assertNonBlank(evidence[key], `production admission ${key}`);
  }
  requiredUtcInstant(evidence.approvedAt, "production admission approvedAt");
  for (const key of [
    "sampleEvidenceHash", "rawSha256", "schemaFingerprint", "sourceSnapshotSetHash",
    "sourceInventorySha256", "adminReviewRecordHash", "licenseEvidenceHash", "aliasLedgerHash",
    "operatorMappingLedgerHash", "facilityEvidenceLedgerHash", "routeEvidenceLedgerHash", "overrideHash",
  ]) assertSha256(evidence[key], `production admission ${key}`);
  for (const key of ["portal", "unlockStatus"]) {
    assertNonBlank(evidence.quotaEvidence[key], `production admission quota ${key}`);
  }
  if (evidence.quotaEvidence.defaultDailyLimit === undefined) {
    throw new Error("production admission quota defaultDailyLimit is required");
  }
}

function validateSnapshotMetadata(snapshot) {
  const metadata = snapshot.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("snapshot metadata must be an object");
  }
  const metadataBytes = `${JSON.stringify(metadata, null, 2)}\n`;
  if (sha256(metadataBytes) !== snapshot.metadataFileSha256) {
    throw new Error("snapshot metadata file hash mismatch");
  }
  const bindings = [
    ["sourceId", snapshot.sourceId],
    ["snapshotId", snapshot.snapshotId],
    ["rawSha256", snapshot.rawSha256],
    ["gzipSha256", snapshot.gzipSha256],
    ["rowCount", snapshot.rowCount],
    ["capturedAt", snapshot.capturedAt],
    ["freshUntil", snapshot.freshUntil],
  ];
  for (const [key, expected] of bindings) {
    if (metadata[key] !== expected) throw new Error(`snapshot metadata ${key} mismatch`);
  }
  assertSha256(metadata.sortedContentSha256, "snapshot metadata sortedContentSha256");
  if (sortedContentSha256(snapshot.rows) !== metadata.sortedContentSha256) {
    throw new Error("snapshot sorted content hash mismatch");
  }
}

function sortedContentSha256(rows) {
  return sha256(JSON.stringify([...rows].sort((left, right) => compareBytes(
    JSON.stringify(left), JSON.stringify(right),
  ))));
}

function enforceExactStationNameMatches(partition) {
  const joined = [];
  const unmatched = [...partition.unmatched];
  for (const entry of partition.joined) {
    if (entry.mappings.every(({ stationName }) => stationName === entry.providerStationName)) {
      joined.push(entry);
      continue;
    }
    const { mappings, ...identity } = entry;
    unmatched.push({
      ...identity,
      reason: "CANONICAL_STATION_NAME_NOT_EXACT",
      candidateStationNames: [...new Set(mappings.map(({ stationName }) => stationName))].sort(compareBytes),
    });
  }
  for (const values of [joined, unmatched, partition.ambiguous]) {
    values.sort((left, right) => compareBytes(providerTupleKey(left), providerTupleKey(right)));
  }
  const sumRows = (entries) => entries.reduce((total, { rowCount }) => total + rowCount, 0);
  return {
    summary: {
      rowCount: partition.summary.rowCount,
      tupleCount: partition.summary.tupleCount,
      joinedTupleCount: joined.length,
      joinedRowCount: sumRows(joined),
      unmatchedTupleCount: unmatched.length,
      unmatchedRowCount: sumRows(unmatched),
      ambiguousTupleCount: partition.ambiguous.length,
      ambiguousRowCount: sumRows(partition.ambiguous),
    },
    joined,
    unmatched,
    ambiguous: partition.ambiguous,
  };
}

function bindProviderEvidence(partition, rows) {
  const evidenceByTuple = providerEvidenceByTuple(rows);
  const bind = (entry) => {
    const providerRecordHash = evidenceByTuple.get(providerTupleKey(entry));
    if (!providerRecordHash) throw new Error("provider tuple evidence is not bound");
    return canonicalObject({ ...entry, providerRecordHash });
  };
  return canonicalObject({
    summary: partition.summary,
    joined: partition.joined.map(bind),
    unmatched: partition.unmatched.map(bind),
    ambiguous: partition.ambiguous.map(bind),
  });
}

function providerEvidenceByTuple(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("provider row must be an object");
    const operator = parseProviderOperator(row.RAIL_OPR_ISTT_CD);
    for (const key of ["LN_NM", "STIN_NM"]) assertNonBlank(row[key], `provider row ${key}`);
    const key = [operator.code, operator.name, row.LN_NM, row.STIN_NM].join("\u0000");
    const values = grouped.get(key) ?? [];
    values.push(canonicalObject(row));
    grouped.set(key, values);
  }
  return new Map([...grouped].map(([key, values]) => [
    key,
    sha256(canonicalJson(values.sort((left, right) => compareBytes(canonicalJson(left), canonicalJson(right))))),
  ]));
}

function providerTupleKey(entry) {
  return [
    entry.providerOperatorCode,
    entry.providerOperatorName,
    entry.providerLineName,
    entry.providerStationName,
  ].join("\u0000");
}

function parseProviderOperator(value) {
  const match = typeof value === "string" ? /^([A-Z0-9]+)\(([^()]+)\)$/.exec(value) : null;
  if (!match) throw new Error("provider operator identity is invalid");
  return { code: match[1], name: match[2].trim() };
}

function indexJoinedMappings(joinedEntries) {
  const index = new Map();
  for (const entry of joinedEntries) {
    for (const mapping of entry.mappings) {
      const key = stationLineKey(mapping);
      if (index.has(key)) throw new Error("duplicate transfer topology mapping");
      index.set(key, entry);
    }
  }
  return index;
}

function buildCell({
  candidate, stationLine, stationLineSetSha256, joined, source, snapshot,
  normalizedEvidenceSha256, topologySourceIdentitySha256,
}) {
  const state = source.stale
    ? "STALE"
    : joined
      ? source.productionAdmitted ? "ADMITTED_TRANSFER_TOPOLOGY" : "BLOCKED_WITH_EVIDENCE"
      : "MISSING";
  const applicabilityReason = {
    ADMITTED_TRANSFER_TOPOLOGY: "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT",
    BLOCKED_WITH_EVIDENCE: "SOURCE_NOT_PRODUCTION_ADMITTED",
    MISSING: "OFFICIAL_TRANSFER_TOPOLOGY_MISSING",
    STALE: "SOURCE_SNAPSHOT_STALE",
  }[state];
  return canonicalObject({
    candidateId: candidate.candidateId,
    stationSetSha256: candidate.stationSetSha256,
    sourceSetSha256: candidate.sourceSetSha256,
    stationLineSetSha256,
    stationLineId: `${stationLine.stationId}:${stationLine.lineId}`,
    stationId: stationLine.stationId,
    lineId: stationLine.lineId,
    operatorId: stationLine.operatorId,
    domain: "TRANSFER",
    state,
    topologySourceIdentitySha256,
    rawEvidenceSha256: snapshot.rawSha256,
    normalizedEvidenceSha256,
    providerRecordHash: joined?.providerRecordHash ?? null,
    capturedAt: source.capturedAt,
    freshUntil: source.freshUntil,
    provenanceId: source.provenanceId,
    licenseId: source.licenseId,
    sourceId: snapshot.sourceId,
    sourceSnapshotId: snapshot.snapshotId,
    mappingContractVersion: candidate.mappingContractVersion,
    materializerVersion: candidate.materializerVersion,
    applicabilityReason,
  });
}

function materializerEvidenceRow(cell) {
  return canonicalObject({
    candidateId: cell.candidateId,
    stationSetSha256: cell.stationSetSha256,
    sourceSetSha256: cell.sourceSetSha256,
    stationId: cell.stationId,
    lineId: cell.lineId,
    operatorId: cell.operatorId,
    domain: "TRANSFER",
    state: "VERIFIED_PRESENT",
    sourceId: cell.sourceId,
    sourceSnapshotId: cell.sourceSnapshotId,
    evidenceRawSha256: cell.rawEvidenceSha256,
    providerRecordHash: cell.providerRecordHash,
    capturedAt: cell.capturedAt,
    freshUntil: cell.freshUntil,
    provenanceId: cell.provenanceId,
    licenseId: cell.licenseId,
    mappingContractVersion: cell.mappingContractVersion,
    materializerVersion: cell.materializerVersion,
    evidenceKind: "OBSERVED",
    evidenceReason: "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT",
  });
}

function stationLineKey(value) {
  return `${value.stationId}\u0000${value.lineId}\u0000${value.operatorId}`;
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actualKeySet = Object.keys(value).sort(compareBytes).join("\u0000");
  const expectedKeySet = [...expected].sort(compareBytes).join("\u0000");
  if (actualKeySet !== expectedKeySet) throw new Error(`${label} mismatch`);
}

function assertNonBlank(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-blank string`);
}

function assertSha256(value, label) {
  if (!isSha256(value)) throw new Error(`${label} must be sha256`);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function canonicalObject(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalObject(entry));
  const result = {};
  for (const key of Object.keys(value).sort(compareBytes)) result[key] = canonicalObject(value[key]);
  return result;
}

function canonicalJson(value) {
  const canonical = canonicalObject(value);
  return JSON.stringify(canonical);
}

function sha256(value) {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
