#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateKricAccessibilitySnapshotIdentity } from "./collect-kric-accessibility-snapshots.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const SOURCE_ID = "kric-station-convenience-standard";
const SNAPSHOT_PATH = "tools/datapack/sources/kric-station-convenience-standard-20260813T200604805Z.json";
const REQUIRED_TYPES = ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"];
const FACILITY_CODE_BY_TYPE = Object.freeze({
  ELEVATOR: "EV",
  ESCALATOR: "ES",
  WHEELCHAIR_LIFT: "WCLF",
});
const DENOMINATOR_STATES = [
  "VERIFIED_PRESENT",
  "VERIFIED_ABSENT",
  "BLOCKED_WITH_EVIDENCE",
  "UNKNOWN",
  "MISSING",
  "STALE",
];
const CELL_STATES = [
  "ADMITTED_FACILITY_PRESENT",
  "ADMITTED_FACILITY_ABSENT",
  "BLOCKED_WITH_EVIDENCE",
  "UNKNOWN",
  "MISSING",
  "STALE",
];
const OUTPUT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "observedAt",
  "candidate",
  "sourceIdentity",
  "stationLineSetSha256",
  "stationLineMappingSha256",
  "sourceInputIdentitySha256",
  "queryPartition",
  "inputEvidencePartition",
  "denominatorRows",
  "denominatorStateSummary",
  "cells",
  "cellStateSummary",
  "materializerEvidenceRows",
  "decision",
  "admissionDigest",
];

export async function loadCurrentFacilitySourceAdmissionInput({ repositoryRoot, observedAt }) {
  assertNonBlank(repositoryRoot, "repositoryRoot");
  assertNonBlank(observedAt, "observedAt");
  const root = path.resolve(repositoryRoot);
  const [candidateBuildSpec, productionInput, sourceInventory, sourceSnapshots, snapshotBytes] = await Promise.all([
    readJson(path.join(root, "tools/datapack/release/candidate-build-spec.json")),
    readJson(path.join(root, "tools/datapack/inputs/capital-pilot-production-source-input.json")),
    readJson(path.join(root, "tools/datapack/source-inventory.json")),
    readJson(path.join(root, "tools/datapack/release/source-snapshots.json")),
    readFile(path.join(root, SNAPSHOT_PATH)),
  ]);
  return {
    observedAt,
    candidateBuildSpec,
    productionInput,
    sourceInventory,
    sourceSnapshots,
    snapshotBytes: new Uint8Array(snapshotBytes),
  };
}

export function buildFacilitySourceAdmission(input) {
  assertKeys(input, [
    "observedAt",
    "candidateBuildSpec",
    "productionInput",
    "sourceInventory",
    "sourceSnapshots",
    "snapshotBytes",
  ], "FACILITY admission input keys");
  const observedAtMillis = requiredUtcInstant(input.observedAt, "observedAt");
  const snapshotBytes = requireBytes(input.snapshotBytes);
  const snapshot = validateKricAccessibilitySnapshotIdentity(parseJson(snapshotBytes, "KRIC snapshot"));
  const sourceContext = validateSourceContext({
    candidateBuildSpec: input.candidateBuildSpec,
    sourceInventory: input.sourceInventory,
    sourceSnapshots: input.sourceSnapshots,
    snapshot,
    snapshotBytes,
    observedAtMillis,
  });
  const stationContext = buildStationContext(input.productionInput, input.candidateBuildSpec);
  const queryContext = partitionQueries(snapshot.queries, stationContext.stationLines);
  const evidencePartition = partitionInputEvidence({
    productionInput: input.productionInput,
    stationContext,
    queryContext,
    snapshot,
  });
  const denominatorRows = buildDenominatorRows({
    stationContext,
    evidencePartition,
    sourceIdentity: sourceContext.sourceIdentity,
    observedAtMillis,
  });
  const denominatorStateSummary = summarize(denominatorRows, DENOMINATOR_STATES);
  const cells = buildCells({
    candidate: stationContext.candidate,
    stationLines: stationContext.stationLines,
    denominatorRows,
    sourceIdentity: sourceContext.sourceIdentity,
    stationLineSetSha256: stationContext.stationLineSetSha256,
    stationLineMappingSha256: stationContext.stationLineMappingSha256,
  });
  const cellStateSummary = summarize(cells, CELL_STATES);
  const decision = queryContext.output.summary.joinedCount === stationContext.stationLines.length
    && queryContext.output.summary.partitionedQueryCount === queryContext.output.summary.totalCount
    && queryContext.output.summary.missingTargetCount === 0
    && queryContext.output.summary.unmatchedCount === 0
    && queryContext.output.summary.ambiguousCount === 0
    && evidencePartition.output.summary.unmatchedCount === 0
    && evidencePartition.output.summary.ambiguousCount === 0
    && evidencePartition.output.summary.duplicateCount === 0
    && evidencePartition.output.summary.blockingCount === 0
    && denominatorRows.every(({ state }) => state === "VERIFIED_PRESENT" || state === "VERIFIED_ABSENT")
    && cells.every(({ state }) => state === "ADMITTED_FACILITY_PRESENT" || state === "ADMITTED_FACILITY_ABSENT")
    ? "GO"
    : "NO_GO";
  const materializerEvidenceRows = decision === "GO"
    ? cells.map((cell) => materializerEvidenceRow({ cell, candidate: stationContext.candidate, sourceContext }))
    : [];
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "facility-source-admission-matrix",
    observedAt: new Date(observedAtMillis).toISOString(),
    candidate: stationContext.candidate,
    sourceIdentity: sourceContext.sourceIdentity,
    stationLineSetSha256: stationContext.stationLineSetSha256,
    stationLineMappingSha256: stationContext.stationLineMappingSha256,
    sourceInputIdentitySha256: sourceInputIdentitySha256(input.productionInput, stationContext),
    queryPartition: queryContext.output,
    inputEvidencePartition: evidencePartition.output,
    denominatorRows,
    denominatorStateSummary,
    cells,
    cellStateSummary,
    materializerEvidenceRows,
    decision,
  });
  return canonicalObject({ ...payload, admissionDigest: sha256(canonicalJson(payload)) });
}

export function canonicalFacilitySourceAdmissionJson(result) {
  assertKeys(result, OUTPUT_KEYS, "FACILITY admission output keys");
  const { admissionDigest, ...payload } = result;
  assertSha256(admissionDigest, "FACILITY admission digest");
  if (sha256(canonicalJson(payload)) !== admissionDigest) {
    throw new Error("FACILITY admission digest mismatch");
  }
  return `${JSON.stringify(canonicalObject(result), null, 2)}\n`;
}

function validateSourceContext({
  candidateBuildSpec, sourceInventory, sourceSnapshots, snapshot, snapshotBytes, observedAtMillis,
}) {
  if (candidateBuildSpec?.schemaVersion !== 1
    || candidateBuildSpec?.artifactKind !== "datapack-candidate-build-spec"
    || !Array.isArray(candidateBuildSpec.sourceSnapshots)
    || !Array.isArray(candidateBuildSpec.sourceSnapshotIds)) {
    throw new Error("candidate build spec identity mismatch");
  }
  for (const key of ["candidateId", "productionScopeId", "sourceSnapshotSetHash"]) {
    assertNonBlank(candidateBuildSpec[key], `candidate build spec ${key}`);
  }
  assertSha256(candidateBuildSpec.sourceSnapshotSetHash, "candidate source snapshot set hash");
  if (!Array.isArray(sourceInventory?.sources) || !Array.isArray(sourceSnapshots)) {
    throw new Error("source registries must be arrays");
  }
  if (candidateBuildSpec.sourceSnapshotIds.length !== candidateBuildSpec.sourceSnapshots.length) {
    throw new Error("candidate source snapshot membership mismatch");
  }
  const selectedSnapshots = candidateBuildSpec.sourceSnapshotIds.map((snapshotId, index) => {
    const selected = exactlyOne(sourceSnapshots, (entry) => entry.snapshotId === snapshotId, "candidate source snapshot");
    const projection = candidateBuildSpec.sourceSnapshots[index];
    for (const key of [
      "snapshotId", "sourceId", "rawObjectUri", "rawSha256", "schemaFingerprint",
      "licenseStatus", "redistributionAllowed", "snapshotStatus", "credentialRedacted",
    ]) {
      if (projection?.[key] !== selected[key]) throw new Error("candidate source snapshot projection mismatch");
    }
    return selected;
  });
  const source = exactlyOne(sourceInventory.sources, ({ id }) => id === SOURCE_ID, "FACILITY source inventory");
  const evidence = source.accessibilityAdmissionEvidence;
  const admission = source.admissionEvidence;
  if (source.productionUseAllowed !== true || source.requiredForProductionPack !== true
    || source.capabilities?.facility?.status !== "SUPPORTED"
    || source.capabilities.facility.productionUseAllowed !== true
    || source.license?.commercialUseAllowed !== true
    || source.license?.derivativeWorkAllowed !== true
    || source.license?.redistributionAllowed !== true
    || typeof source.license?.attribution !== "string" || source.license.attribution.trim() === "") {
    throw new Error("FACILITY source production admission mismatch");
  }
  if (admission?.decision !== "APPROVED" || evidence?.decision !== "APPROVED"
    || evidence.productionUseAllowed !== true
    || evidence.licenseEvidenceHash !== admission.licenseEvidenceHash) {
    throw new Error("FACILITY source approval or license mismatch");
  }
  assertSha256(evidence.licenseEvidenceHash, "FACILITY license evidence");
  if (evidence.snapshotPath !== SNAPSHOT_PATH
    || evidence.snapshotId !== snapshot.snapshotId
    || evidence.rawSha256 !== snapshot.rawSha256
    || evidence.contentSha256 !== snapshot.contentSha256
    || evidence.schemaFingerprint !== snapshot.schemaFingerprint
    || evidence.capturedAt !== snapshot.capturedAt
    || evidence.observedAt !== snapshot.observedAt
    || evidence.freshUntil !== snapshot.freshUntil) {
    throw new Error("FACILITY snapshot admission identity mismatch");
  }
  if (evidence.absenceEvidenceMode !== "EXHAUSTIVE_LIST") {
    throw new Error("FACILITY absence evidence mode mismatch");
  }
  const snapshotFileSha256 = sha256(snapshotBytes);
  if (evidence.snapshotFileSha256 !== snapshotFileSha256) {
    throw new Error("FACILITY snapshot file identity mismatch");
  }
  const ledger = exactlyOne(
    sourceSnapshots,
    (entry) => entry.sourceId === SOURCE_ID && entry.snapshotId === snapshot.snapshotId,
    "FACILITY source snapshot ledger",
  );
  const receipt = ledger.rawReceipt;
  const candidateMember = exactlyOne(
    candidateBuildSpec.sourceSnapshots,
    (entry) => entry.sourceId === SOURCE_ID && entry.snapshotId === snapshot.snapshotId,
    "FACILITY candidate source membership",
  );
  if (ledger.schemaFingerprint !== snapshot.schemaFingerprint
    || candidateMember.schemaFingerprint !== snapshot.schemaFingerprint) {
    throw new Error("FACILITY schema fingerprint mismatch");
  }
  if (!candidateBuildSpec.sourceSnapshotIds.includes(snapshot.snapshotId)
    || candidateBuildSpec.sourceSnapshotIds.filter((value) => value === snapshot.snapshotId).length !== 1) {
    throw new Error("FACILITY candidate source id membership mismatch");
  }
  if (ledger.snapshotStatus !== "LOCKED" || ledger.schemaStatus !== "PASS"
    || ledger.licenseStatus !== "PASS" || ledger.fetchStatus !== "SUCCESS"
    || ledger.credentialRedacted !== true || ledger.redistributionAllowed !== true
    || candidateMember.snapshotStatus !== "LOCKED" || candidateMember.licenseStatus !== "PASS"
    || candidateMember.credentialRedacted !== true || candidateMember.redistributionAllowed !== true) {
    throw new Error("FACILITY source policy mismatch");
  }
  const receiptMatches = receipt?.sourceId === SOURCE_ID
    && receipt.snapshotId === snapshot.snapshotId
    && receipt.snapshotRawSha256 === snapshot.rawSha256
    && receipt.snapshotFileSha256 === snapshotFileSha256
    && receipt.rawObjectSha256 === ledger.rawSha256
    && receipt.rawObjectSha256 === candidateMember.rawSha256
    && ledger.rawObjectUri === candidateMember.rawObjectUri;
  if (!receiptMatches) throw new Error("FACILITY raw receipt identity mismatch");
  if (sha256(JSON.stringify(selectedSnapshots)) !== candidateBuildSpec.sourceSnapshotSetHash) {
    throw new Error("candidate source snapshot set identity mismatch");
  }
  for (const value of [ledger.rawSha256, receipt.rawObjectSha256, evidence.rawSha256, snapshotFileSha256]) {
    assertSha256(value, "FACILITY raw identity");
  }
  const capturedAtMillis = requiredUtcInstant(snapshot.capturedAt, "FACILITY snapshot capturedAt");
  const freshUntilMillis = requiredUtcInstant(snapshot.freshUntil, "FACILITY snapshot freshUntil");
  if (capturedAtMillis > observedAtMillis || freshUntilMillis <= capturedAtMillis) {
    throw new Error("FACILITY snapshot time identity mismatch");
  }
  return {
    sourceIdentity: canonicalObject({
      sourceId: SOURCE_ID,
      snapshotId: snapshot.snapshotId,
      snapshotPayloadRawSha256: snapshot.rawSha256,
      snapshotFileSha256,
      rawObjectSha256: receipt.rawObjectSha256,
      contentSha256: snapshot.contentSha256,
      schemaFingerprint: snapshot.schemaFingerprint,
      capturedAt: snapshot.capturedAt,
      freshUntil: snapshot.freshUntil,
      rawObjectUri: ledger.rawObjectUri,
      credentialRedacted: true,
      licenseId: evidence.licenseEvidenceHash,
      provenanceId: snapshotFileSha256,
    }),
    licenseId: evidence.licenseEvidenceHash,
    provenanceId: snapshotFileSha256,
  };
}

function buildStationContext(productionInput, candidateBuildSpec) {
  const scope = productionInput?.supportedV1Scope;
  if (!scope || scope.scopeId !== candidateBuildSpec.productionScopeId
    || scope.facilityCoverageDenominator?.kind !== "station_line_x_required_facility_type"
    || !Array.isArray(scope.includedStationIds) || !Array.isArray(scope.includedLineIds)
    || !Array.isArray(scope.includedOperatorIds) || !Array.isArray(scope.includedRegionIds)
    || !Array.isArray(scope.requiredFacilityTypes)) {
    throw new Error("FACILITY production scope mismatch");
  }
  const requiredTypes = uniqueStrings(scope.requiredFacilityTypes, "required facility type").sort(compareBytes);
  if (canonicalJson(requiredTypes) !== canonicalJson([...REQUIRED_TYPES].sort(compareBytes))) {
    throw new Error("FACILITY required type contract mismatch");
  }
  const stationIds = uniqueStrings(scope.includedStationIds, "included station id").sort(compareBytes);
  const lineIds = uniqueStrings(scope.includedLineIds, "included line id").sort(compareBytes);
  const operatorIds = uniqueStrings(scope.includedOperatorIds, "included operator id").sort(compareBytes);
  const regionIds = uniqueStrings(scope.includedRegionIds, "included region id").sort(compareBytes);
  if (stationIds.length !== 2 || lineIds.length !== 1 || operatorIds.length !== 1 || regionIds.length !== 1) {
    throw new Error("FACILITY current scope cardinality mismatch");
  }
  if (!Array.isArray(productionInput.stationMappings) || !Array.isArray(productionInput.stationLineRows)
    || !Array.isArray(productionInput.lines) || !Array.isArray(productionInput.operators)) {
    throw new Error("FACILITY station mapping inputs are required");
  }
  const line = exactlyOne(productionInput.lines, ({ id }) => id === lineIds[0], "FACILITY line");
  const operator = exactlyOne(productionInput.operators, ({ id }) => id === operatorIds[0], "FACILITY operator");
  if (line.operatorId !== operator.id) throw new Error("FACILITY line operator identity mismatch");
  const stationLines = stationIds.map((stationId) => {
    const mapping = exactlyOne(
      productionInput.stationMappings,
      (row) => row.sourceId === "molit-urban-rail-full-route"
        && row.stationId === stationId && row.lineId === line.id && row.mappingStatus === "active",
      `FACILITY station mapping ${stationId}`,
    );
    if (mapping.stationLineId !== `${stationId}:${line.id}`) {
      throw new Error("FACILITY station-line identity mismatch");
    }
    const sourceRow = exactlyOne(
      productionInput.stationLineRows,
      (row) => row.sourceId === mapping.sourceId
        && row.sourceStationCode === mapping.sourceStationCode && row.lineId === line.id,
      `FACILITY station row ${stationId}`,
    );
    const stationAliases = productionInput.stationMappings
      .filter((row) => row.stationId === stationId && row.lineId === line.id && Array.isArray(row.previousNames))
      .flatMap(({ previousNames }) => previousNames)
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort(compareBytes);
    return canonicalObject({
      stationId,
      stationName: requiredString(sourceRow.normalizedName, "FACILITY station name"),
      stationAliases,
      regionId: regionIds[0],
      lineId: line.id,
      lineName: requiredString(line.nameKo, "FACILITY line name"),
      operatorId: operator.id,
      operatorName: requiredString(operator.nameKo, "FACILITY operator name"),
      sourceId: mapping.sourceId,
      sourceStationCode: mapping.sourceStationCode,
    });
  }).sort(compareStationLines);
  if (scope.facilityCoverageDenominator.expectedRows !== stationLines.length * requiredTypes.length) {
    throw new Error("FACILITY denominator count mismatch");
  }
  const stationLineSet = stationLines.map(({ stationId, lineId, operatorId }) => canonicalObject({
    stationId, lineId, operatorId,
  }));
  const mappingRows = stationLines.map((row) => canonicalObject(row));
  const candidate = canonicalObject({
    candidateId: candidateBuildSpec.candidateId,
    stationSetSha256: sha256(canonicalJson(stationIds)),
    sourceSetSha256: candidateBuildSpec.sourceSnapshotSetHash,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
  });
  return {
    candidate,
    requiredTypes,
    stationLines,
    stationLineSetSha256: sha256(canonicalJson(stationLineSet)),
    stationLineMappingSha256: sha256(canonicalJson(mappingRows)),
  };
}

function partitionQueries(queries, stationLines) {
  const targetByKey = new Map(stationLines.map((line) => [stationLineKey(line), line]));
  const candidateQueriesByKey = new Map();
  const outOfScope = [];
  for (const query of queries) {
    const key = stationLineKey(query);
    if (!targetByKey.has(key)) {
      outOfScope.push(queryProjection(query, "OUT_OF_CURRENT_SCOPE"));
      continue;
    }
    const values = candidateQueriesByKey.get(key) ?? [];
    values.push(query);
    candidateQueriesByKey.set(key, values);
  }
  const joined = [];
  const unmatched = [];
  const ambiguous = [];
  const missingTargets = [];
  const joinedQueryByStationLine = new Map();
  for (const line of stationLines) {
    const key = stationLineKey(line);
    const candidates = candidateQueriesByKey.get(key) ?? [];
    const mapped = candidates.filter((query) => query.canonicalMappings.some((mapping) =>
      mapping.artifactId === "bundled-capital"
      && mapping.stationId === line.stationId && mapping.lineId === line.lineId));
    if (mapped.length === 1 && candidates.length === 1
      && mapped[0].canonicalMappings.filter(({ artifactId }) => artifactId === "bundled-capital").length === 1) {
      joined.push(queryProjection(mapped[0], "JOINED_CURRENT_SCOPE"));
      joinedQueryByStationLine.set(key, mapped[0]);
    } else if (candidates.length === 0) {
      missingTargets.push(canonicalObject({
        stationId: line.stationId,
        lineId: line.lineId,
        reason: "CURRENT_STATION_LINE_QUERY_MISSING",
      }));
    } else if (mapped.length === 0) {
      unmatched.push(...candidates.map((query) => queryProjection(query, "CURRENT_STATION_LINE_QUERY_UNMATCHED")));
    } else {
      ambiguous.push(...candidates.map((query) => queryProjection(query, "CURRENT_STATION_LINE_QUERY_AMBIGUOUS")));
    }
  }
  for (const values of [joined, outOfScope, unmatched, ambiguous, missingTargets]) values.sort(compareProjection);
  const partitionedQueryCount = joined.length + outOfScope.length + unmatched.length + ambiguous.length;
  return {
    output: canonicalObject({
      summary: {
        totalCount: queries.length,
        partitionedQueryCount,
        joinedCount: joined.length,
        outOfScopeCount: outOfScope.length,
        unmatchedCount: unmatched.length,
        ambiguousCount: ambiguous.length,
        missingTargetCount: missingTargets.length,
      },
      joined,
      outOfScope,
      unmatched,
      ambiguous,
      missingTargets,
    }),
    joinedQueryByStationLine,
  };
}

function partitionInputEvidence({ productionInput, stationContext, queryContext, snapshot }) {
  if (!Array.isArray(productionInput.facilityRows)
    || !Array.isArray(productionInput.accessibilityStatusEvidence)) {
    throw new Error("FACILITY consumer evidence inputs are required");
  }
  const stationLineByKey = new Map(stationContext.stationLines.map((line) => [stationLineKey(line), line]));
  const joinedQueryByStationLine = queryContext.joinedQueryByStationLine;
  const stationBySourceMapping = new Map(stationContext.stationLines.map((line) => [
    `${line.sourceId}\0${line.sourceStationCode}\0${line.lineId}`,
    line,
  ]));
  const joined = [];
  const outOfDomain = [];
  const unmatched = [];
  const ambiguous = [];
  const duplicate = [];
  const blocking = [];
  const seenFacilityIds = new Set();
  const seenFacilityHashes = new Set();
  const seenAbsenceKeys = new Set();
  const evidenceByDenominator = new Map();

  for (const row of productionInput.facilityRows) {
    const evidenceId = `FACILITY:${requiredString(row?.id, "FACILITY row id")}`;
    if (seenFacilityIds.has(row.id) || seenFacilityHashes.has(row.providerRecordHash)) {
      throw new Error("duplicate FACILITY evidence");
    }
    seenFacilityIds.add(row.id);
    seenFacilityHashes.add(row.providerRecordHash);
    if (row.sourceId !== SOURCE_ID || !REQUIRED_TYPES.includes(row.type)) {
      outOfDomain.push(partitionProjection(evidenceId, row, "NON_CURRENT_FACILITY_SOURCE_OR_TYPE", false));
      continue;
    }
    const line = stationBySourceMapping.get(`${row.station?.sourceId}\0${row.station?.sourceStationCode}\0${row.station?.lineId}`);
    if (!line || !stationLineByKey.has(stationLineKey(line))) {
      unmatched.push(partitionProjection(evidenceId, row, "FACILITY_STATION_LINE_UNMATCHED", true));
      blocking.push(evidenceId);
      continue;
    }
    const query = joinedQueryByStationLine.get(stationLineKey(line));
    if (!query) {
      unmatched.push(partitionProjection(evidenceId, row, "FACILITY_QUERY_UNMATCHED", true));
      blocking.push(evidenceId);
      continue;
    }
    validatePresentEvidence(row, line, query, snapshot);
    const projected = canonicalObject({
      evidenceId,
      inputKind: "FACILITY",
      stationId: line.stationId,
      lineId: line.lineId,
      facilityType: row.type,
      state: "VERIFIED_PRESENT",
      providerRecordHash: row.providerRecordHash,
      evidenceHash: row.evidenceHash,
    });
    joined.push(projected);
    addDenominatorEvidence(evidenceByDenominator, line, row.type, projected);
  }

  for (const row of productionInput.accessibilityStatusEvidence) {
    const evidenceId = `STATUS:${sha256(canonicalJson(row))}`;
    if (row.sourceId !== SOURCE_ID || !REQUIRED_TYPES.includes(row.facilityType)) {
      const allowedProbe = row.sourceId === "seoul-metro-accessibility"
        && row.facilityType === "ACCESSIBILITY_STATUS_PROBE";
      outOfDomain.push(partitionProjection(evidenceId, row, "NON_FACILITY_ADMISSION_STATUS", !allowedProbe));
      if (!allowedProbe) blocking.push(evidenceId);
      continue;
    }
    const key = `${row.stationId}\0${row.lineId}\0${row.facilityType}`;
    if (seenAbsenceKeys.has(key)) throw new Error("duplicate FACILITY evidence");
    seenAbsenceKeys.add(key);
    const line = stationLineByKey.get(stationLineKey(row));
    if (!line) {
      unmatched.push(partitionProjection(evidenceId, row, "FACILITY_STATUS_STATION_LINE_UNMATCHED", true));
      blocking.push(evidenceId);
      continue;
    }
    const query = joinedQueryByStationLine.get(stationLineKey(line));
    if (!query) {
      unmatched.push(partitionProjection(evidenceId, row, "FACILITY_STATUS_QUERY_UNMATCHED", true));
      blocking.push(evidenceId);
      continue;
    }
    validateAbsenceEvidence(row, query, snapshot);
    const projected = canonicalObject({
      evidenceId,
      inputKind: "EXPLICIT_ABSENCE",
      stationId: line.stationId,
      lineId: line.lineId,
      facilityType: row.facilityType,
      state: "VERIFIED_ABSENT",
      providerRecordHash: row.providerRecordHash,
      evidenceHash: row.evidenceHash,
    });
    joined.push(projected);
    addDenominatorEvidence(evidenceByDenominator, line, row.facilityType, projected);
  }
  for (const values of [joined, outOfDomain, unmatched, ambiguous, duplicate]) values.sort(compareEvidenceProjection);
  const totalCount = productionInput.facilityRows.length + productionInput.accessibilityStatusEvidence.length;
  if (joined.length + outOfDomain.length + unmatched.length + ambiguous.length + duplicate.length !== totalCount) {
    throw new Error("FACILITY input evidence partition mismatch");
  }
  return {
    evidenceByDenominator,
    output: canonicalObject({
      summary: {
        totalCount,
        joinedCount: joined.length,
        outOfDomainCount: outOfDomain.length,
        unmatchedCount: unmatched.length,
        ambiguousCount: ambiguous.length,
        duplicateCount: duplicate.length,
        blockingCount: blocking.length,
      },
      joined,
      outOfDomain,
      unmatched,
      ambiguous,
      duplicate,
    }),
  };
}

function validatePresentEvidence(row, line, query, snapshot) {
  const expectedCode = FACILITY_CODE_BY_TYPE[row.type];
  const matchingRows = query.rows.filter((sourceRow) => sourceRow.gubun === expectedCode
    && sha256(JSON.stringify(sourceRow)) === row.providerRecordHash);
  const tuple = providerTuple(query);
  const expectedEvidenceHash = sha256(JSON.stringify({
    snapshotId: snapshot.snapshotId,
    query: tuple,
    providerRecordHash: row.providerRecordHash,
  }));
  if (matchingRows.length !== 1 || row.sourceSnapshotId !== snapshot.snapshotId
    || row.evidenceHash !== expectedEvidenceHash
    || row.provenanceKind !== "OFFICIAL_SOURCE"
    || row.status !== "UNKNOWN" || row.statusMeaning !== "STATIC_LOCATION"
    || row.operationalStatus !== "UNKNOWN"
    || row.installationStatus !== "INSTALLED"
    || row.confidence !== 100
    || typeof row.providerFacilityRef !== "string" || !row.providerFacilityRef.endsWith(row.providerRecordHash)
    || row.verifiedAt !== snapshot.capturedAt || row.retrievedAt !== snapshot.capturedAt
    || row.station.lineId !== line.lineId) {
    throw new Error("FACILITY present evidence identity mismatch");
  }
}

function validateAbsenceEvidence(row, query, snapshot) {
  const expectedCode = FACILITY_CODE_BY_TYPE[row.facilityType];
  const expectedEvidenceHash = sha256(JSON.stringify({
    snapshotId: snapshot.snapshotId,
    query: providerTuple(query),
    type: row.facilityType,
    evidenceKind: "NOT_EXISTS",
  }));
  if (query.rows.some(({ gubun }) => gubun === expectedCode)
    || row.evidenceKind !== "NOT_EXISTS"
    || row.sourceSnapshotId !== snapshot.snapshotId
    || row.providerRecordHash !== query.providerRecordHash
    || row.evidenceHash !== expectedEvidenceHash
    || row.provenanceKind !== "OFFICIAL_SOURCE"
    || row.installationStatus !== "NOT_INSTALLED"
    || row.operationalStatus !== "NOT_APPLICABLE"
    || row.statusMeaning !== "EXHAUSTIVE_LIST_ABSENCE"
    || row.strictRouteEligibleReason !== "FACILITY_NOT_INSTALLED"
    || row.confidence !== 100
    || row.verifiedAt !== snapshot.capturedAt || row.retrievedAt !== snapshot.capturedAt) {
    throw new Error("FACILITY explicit absence identity mismatch");
  }
}

function addDenominatorEvidence(index, line, facilityType, evidence) {
  const key = `${stationLineKey(line)}\0${facilityType}`;
  const values = index.get(key) ?? [];
  values.push(evidence);
  index.set(key, values);
}

function buildDenominatorRows({ stationContext, evidencePartition, sourceIdentity, observedAtMillis }) {
  const stale = requiredUtcInstant(sourceIdentity.freshUntil, "FACILITY source freshUntil") <= observedAtMillis;
  return stationContext.stationLines.flatMap((line) => stationContext.requiredTypes.map((facilityType) => {
    const key = `${stationLineKey(line)}\0${facilityType}`;
    const evidence = evidencePartition.evidenceByDenominator.get(key) ?? [];
    const present = evidence.filter(({ state }) => state === "VERIFIED_PRESENT");
    const absent = evidence.filter(({ state }) => state === "VERIFIED_ABSENT");
    if (present.length > 0 && absent.length > 0) throw new Error("conflicting FACILITY evidence");
    let state = "MISSING";
    let evidenceKind = null;
    let evidenceReason = "OFFICIAL_FACILITY_EVIDENCE_MISSING";
    let providerRecordHash = null;
    let evidenceHash = null;
    if (present.length > 0) {
      state = "VERIFIED_PRESENT";
      evidenceKind = "OBSERVED";
      evidenceReason = "OFFICIAL_FACILITY_PRESENT";
      providerRecordHash = sha256(canonicalJson(present.map(({ providerRecordHash: value }) => value).sort(compareBytes)));
      evidenceHash = sha256(canonicalJson(present.map(({ evidenceHash: value }) => value).sort(compareBytes)));
    } else if (absent.length === 1) {
      state = "VERIFIED_ABSENT";
      evidenceKind = "EXHAUSTIVE_LIST";
      evidenceReason = "OFFICIAL_FACILITY_EXHAUSTIVE_ABSENCE";
      providerRecordHash = absent[0].providerRecordHash;
      evidenceHash = absent[0].evidenceHash;
    }
    if (stale && (state === "VERIFIED_PRESENT" || state === "VERIFIED_ABSENT")) {
      state = "STALE";
      evidenceReason = "OFFICIAL_FACILITY_SOURCE_STALE";
    }
    return canonicalObject({
      stationLineId: `${line.stationId}:${line.lineId}`,
      stationId: line.stationId,
      lineId: line.lineId,
      operatorId: line.operatorId,
      facilityType,
      state,
      sourceId: sourceIdentity.sourceId,
      sourceSnapshotId: sourceIdentity.snapshotId,
      evidenceRawSha256: sourceIdentity.rawObjectSha256,
      providerRecordHash,
      evidenceHash,
      capturedAt: sourceIdentity.capturedAt,
      freshUntil: sourceIdentity.freshUntil,
      provenanceId: sourceIdentity.provenanceId,
      licenseId: sourceIdentity.licenseId,
      evidenceKind,
      evidenceReason,
    });
  })).sort(compareDenominatorRows);
}

function buildCells({
  candidate, stationLines, denominatorRows, sourceIdentity, stationLineSetSha256, stationLineMappingSha256,
}) {
  return stationLines.map((line) => {
    const rows = denominatorRows.filter((row) => row.stationId === line.stationId && row.lineId === line.lineId);
    let state;
    let admissionReason;
    if (rows.some((row) => row.state === "STALE")) {
      state = "STALE";
      admissionReason = "OFFICIAL_FACILITY_SOURCE_STALE";
    } else if (rows.some((row) => row.state === "MISSING")) {
      state = "MISSING";
      admissionReason = "OFFICIAL_FACILITY_EVIDENCE_MISSING";
    } else if (rows.some((row) => row.state === "UNKNOWN")) {
      state = "UNKNOWN";
      admissionReason = "OFFICIAL_FACILITY_EVIDENCE_UNKNOWN";
    } else if (rows.some((row) => row.state === "BLOCKED_WITH_EVIDENCE")) {
      state = "BLOCKED_WITH_EVIDENCE";
      admissionReason = "OFFICIAL_FACILITY_EVIDENCE_BLOCKED";
    } else if (rows.some((row) => row.state === "VERIFIED_PRESENT")) {
      state = "ADMITTED_FACILITY_PRESENT";
      admissionReason = "OFFICIAL_REQUIRED_FACILITY_PRESENT";
    } else {
      state = "ADMITTED_FACILITY_ABSENT";
      admissionReason = "OFFICIAL_REQUIRED_FACILITY_EXHAUSTIVE_ABSENCE";
    }
    return canonicalObject({
      candidateId: candidate.candidateId,
      stationSetSha256: candidate.stationSetSha256,
      sourceSetSha256: candidate.sourceSetSha256,
      stationLineSetSha256,
      stationLineMappingSha256,
      stationLineId: `${line.stationId}:${line.lineId}`,
      stationId: line.stationId,
      lineId: line.lineId,
      operatorId: line.operatorId,
      domain: "FACILITY",
      state,
      admissionReason,
      providerRecordHash: sha256(canonicalJson(rows.map((row) => ({
        facilityType: row.facilityType,
        state: row.state,
        providerRecordHash: row.providerRecordHash,
        evidenceHash: row.evidenceHash,
      })))),
      sourceId: sourceIdentity.sourceId,
      sourceSnapshotId: sourceIdentity.snapshotId,
      evidenceRawSha256: sourceIdentity.rawObjectSha256,
      capturedAt: sourceIdentity.capturedAt,
      freshUntil: sourceIdentity.freshUntil,
      provenanceId: sourceIdentity.provenanceId,
      licenseId: sourceIdentity.licenseId,
      mappingContractVersion: candidate.mappingContractVersion,
      materializerVersion: candidate.materializerVersion,
    });
  }).sort(compareCells);
}

function materializerEvidenceRow({ cell, candidate, sourceContext }) {
  const present = cell.state === "ADMITTED_FACILITY_PRESENT";
  return canonicalObject({
    candidateId: candidate.candidateId,
    stationSetSha256: candidate.stationSetSha256,
    sourceSetSha256: candidate.sourceSetSha256,
    stationId: cell.stationId,
    lineId: cell.lineId,
    operatorId: cell.operatorId,
    domain: "FACILITY",
    state: present ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
    sourceId: cell.sourceId,
    sourceSnapshotId: cell.sourceSnapshotId,
    evidenceRawSha256: cell.evidenceRawSha256,
    providerRecordHash: cell.providerRecordHash,
    capturedAt: cell.capturedAt,
    freshUntil: cell.freshUntil,
    provenanceId: sourceContext.provenanceId,
    licenseId: sourceContext.licenseId,
    mappingContractVersion: candidate.mappingContractVersion,
    materializerVersion: candidate.materializerVersion,
    evidenceKind: present ? "OBSERVED" : "EXHAUSTIVE_LIST",
    evidenceReason: cell.admissionReason,
  });
}

function sourceInputIdentitySha256(productionInput, stationContext) {
  const facilityRows = productionInput.facilityRows.map((row) => canonicalObject(row)).sort(compareCanonical);
  const accessibilityStatusEvidence = productionInput.accessibilityStatusEvidence
    .map((row) => canonicalObject(row)).sort(compareCanonical);
  return sha256(canonicalJson({
    productionScopeId: productionInput.supportedV1Scope.scopeId,
    candidate: stationContext.candidate,
    stationLines: stationContext.stationLines,
    requiredFacilityTypes: stationContext.requiredTypes,
    facilityRows,
    accessibilityStatusEvidence,
  }));
}

function queryProjection(query, state) {
  return canonicalObject({
    stationId: query.stationId,
    lineId: query.lineId,
    providerOperatorId: query.railOprIsttCd,
    providerLineId: query.lnCd,
    providerStationId: query.stinCd,
    providerTupleSha256: providerTupleSha256(query),
    status: query.status,
    rowCount: query.rows.length,
    providerRecordHash: query.providerRecordHash,
    partitionState: state,
  });
}

function partitionProjection(evidenceId, row, reason, blocking) {
  return canonicalObject({
    evidenceId,
    sourceId: row?.sourceId ?? null,
    stationId: row?.stationId ?? null,
    lineId: row?.lineId ?? row?.station?.lineId ?? null,
    facilityType: row?.facilityType ?? row?.type ?? null,
    reason,
    blocking,
  });
}

function providerTuple(query) {
  return {
    railOprIsttCd: query.railOprIsttCd,
    lnCd: query.lnCd,
    stinCd: query.stinCd,
  };
}

function providerTupleSha256(query) {
  return sha256(canonicalJson(providerTuple(query)));
}

function summarize(rows, states) {
  return Object.fromEntries(states.map((state) => [state, rows.filter((row) => row.state === state).length]));
}

function exactlyOne(values, predicate, label) {
  const matches = values.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label} must match exactly once`);
  return matches[0];
}

function uniqueStrings(values, label) {
  const seen = new Set();
  for (const value of values) {
    assertNonBlank(value, label);
    if (seen.has(value)) throw new Error(`${label} must be unique`);
    seen.add(value);
  }
  return [...values];
}

function stationLineKey(value) {
  return `${value.stationId}\0${value.lineId}`;
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareProjection(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.providerTupleSha256 ?? "", right.providerTupleSha256 ?? "");
}

function compareEvidenceProjection(left, right) {
  return compareBytes(left.evidenceId, right.evidenceId);
}

function compareDenominatorRows(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.facilityType, right.facilityType);
}

function compareCells(left, right) {
  return compareBytes(left.stationId, right.stationId) || compareBytes(left.lineId, right.lineId);
}

function compareCanonical(left, right) {
  return compareBytes(canonicalJson(left), canonicalJson(right));
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object" || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareBytes(left, right))
    .map(([key, entry]) => [key, canonicalObject(entry)]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error("snapshotBytes must be non-empty bytes");
  }
  return Buffer.from(value);
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} mismatch`);
  }
}

function assertNonBlank(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-blank string`);
}

function requiredString(value, label) {
  assertNonBlank(value, label);
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be sha256`);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} must be JSON`);
  }
}

async function readJson(target) {
  return parseJson(await readFile(target), target);
}

function parseArgs(argv) {
  const result = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") {
      result.check = true;
      continue;
    }
    if (token !== "--output" && token !== "--observed-at") throw new Error(`unsupported argument: ${token}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${token}`);
    result[token.slice(2)] = value;
    index += 1;
  }
  return result;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.output) throw new Error("missing --output");
  let observedAt = args["observed-at"];
  if (args.check && !observedAt) observedAt = (await readJson(args.output)).observedAt;
  if (!observedAt) throw new Error("missing --observed-at");
  const input = await loadCurrentFacilitySourceAdmissionInput({
    repositoryRoot: process.cwd(),
    observedAt,
  });
  const bytes = Buffer.from(canonicalFacilitySourceAdmissionJson(buildFacilitySourceAdmission(input)));
  if (args.check) {
    const current = await readFile(args.output);
    if (!current.equals(bytes)) throw new Error("FACILITY admission output is stale");
    return;
  }
  await writeFile(args.output, bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
