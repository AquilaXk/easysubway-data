#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildExitPathAdmission,
  canonicalExitPathAdmissionJson,
} from "./build-exit-path-admission.mjs";
import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";
import { canonicalFacilitySourceAdmissionJson } from "./build-facility-source-admission.mjs";
import { canonicalKricExitPathProviderSnapshotJson } from "./collect-kric-exit-path-provider-snapshot.mjs";
import { consumeCurrentKricExitCollectionBundle } from "./consume-current-kric-exit-collection-bundle.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";

const SOURCE_ID = "kric-station-movement-standard";
const PROVIDER_SNAPSHOT_KEYS = [
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "freshUntil",
  "credentialRedacted", "collectionPlanDigest", "queryPlanSha256", "coverage", "queryPlan",
  "results", "snapshotDigest",
];
const QUERY_KEYS = [
  "queryId", "routeEdgeId", "providerOperatorId", "providerLineId", "providerStationId",
  "providerNextStationId", "operatorName", "lineName", "stationName", "regionId",
];
const PROVIDER_RESULT_KEYS = [
  "queryId", "state", "providerResultCode", "rawResponseSha256", "rawResponseByteSize",
  "providerRecordHash", "rows",
];
const PROVIDER_ROW_KEYS = [
  "edMovePath", "elvtSttCd", "elvtTpCd", "exitMvTpOrdr",
  "imgPath", "mvContDtl", "mvPathMgNo", "stMovePath",
];
const PROVIDER_STATES = new Set([
  "ROWS_OBSERVED", "EXPLICIT_ZERO", "PROVIDER_NO_DATA", "PROVIDER_RESULT_UNVERIFIED",
]);
const SOURCE_COVERAGE_KEYS = ["regionIds", "operatorIds", "sourceDomains"];
const COLLECTION_PLAN_KEYS = [
  "schemaVersion", "artifactKind", "candidate", "providerMappings", "routeEdges",
  "queryPlan", "stationLineQueries", "queryPlanSha256", "collectionPlanDigest",
];
const COLLECTION_CANDIDATE_KEYS = [
  "candidateId", "stationSetSha256", "stationLineSetSha256", "stationLineMappingSha256",
  "providerMappingSha256", "topologySha256",
];
const PROVIDER_MAPPING_KEYS = [
  "stationId", "lineId", "providerOperatorId", "providerLineId", "providerStationId",
];
const NORMALIZED_FILE = "exit-path-normalized-source-snapshot.json";
const ADMISSION_FILE = "exit-path-source-admission.json";

export function buildCurrentExitPathSourceAdmission(input) {
  assertKeys(input, [
    "providerSnapshotBytes", "collectionPlan", "facilityAdmission", "candidateBuildSpec",
    "sourceInventory", "sourceSnapshots", "observedAt",
  ], "current EXIT admission input keys");
  const observedAt = requiredUtcInstant(input.observedAt, "observedAt");
  const providerBytes = requireBytes(input.providerSnapshotBytes, "provider snapshot");
  const providerSnapshot = validateProviderSnapshot(providerBytes, observedAt);
  const collectionPlan = validateCollectionPlan(input.collectionPlan, providerSnapshot);
  const facilityAdmission = validateFacilityAdmission(input.facilityAdmission);
  const { candidateBuildSpec, selectedSnapshots } = validateCandidateBuildSpec(
    input.candidateBuildSpec,
    facilityAdmission.candidate,
    input.sourceSnapshots,
  );
  const source = validateSourceInventory(input.sourceInventory);
  const stationContext = buildStationContext(
    facilityAdmission,
    collectionPlan,
    source.coverageScope,
  );
  const selectedQueryIds = new Set(stationContext.queries.map(({ queryId }) => queryId));
  const resultByQuery = new Map(providerSnapshot.results.map((result) => [result.queryId, result]));
  const normalizedResults = stationContext.queries.map((query) => normalizeResult(resultByQuery.get(query.queryId)));
  if (normalizedResults.length !== selectedQueryIds.size) {
    throw new Error("current EXIT normalized result coverage mismatch");
  }
  const providerSnapshotRawSha256 = sha256(providerBytes);
  const providerSnapshotIdentity = canonicalObject({
    sourceId: providerSnapshot.sourceId,
    snapshotId: providerSnapshot.snapshotId,
    capturedAt: providerSnapshot.capturedAt,
    freshUntil: providerSnapshot.freshUntil,
    snapshotDigest: providerSnapshot.snapshotDigest,
    rawSha256: providerSnapshotRawSha256,
    collectionPlanDigest: providerSnapshot.collectionPlanDigest,
    queryPlanSha256: providerSnapshot.queryPlanSha256,
  });
  const normalizedSnapshot = canonicalObject({
    schemaVersion: 3,
    artifactKind: "exit-path-normalized-source-snapshot",
    sourceId: providerSnapshot.sourceId,
    snapshotId: providerSnapshot.snapshotId,
    capturedAt: providerSnapshot.capturedAt,
    freshUntil: providerSnapshot.freshUntil,
    providerSnapshotIdentity,
    coverage: canonicalObject({
      exhaustive: providerSnapshot.coverage.requestPlanComplete,
      queryIds: stationContext.queries.map(({ queryId }) => queryId).sort(compareBytes),
    }),
    queryPlan: stationContext.queries,
    results: normalizedResults.sort(compareResults),
  });
  const normalizedSnapshotBytes = Buffer.from(canonicalJson(normalizedSnapshot));
  const sourceAdmission = canonicalObject({
    schemaVersion: 2,
    artifactKind: "exit-path-source-admission",
    candidateId: facilityAdmission.candidate.candidateId,
    sourceId: providerSnapshot.sourceId,
    snapshotId: providerSnapshot.snapshotId,
    rawSha256: sha256(normalizedSnapshotBytes),
    sourceSnapshotSetHash: facilityAdmission.candidate.sourceSetSha256,
    stationSetSha256: facilityAdmission.candidate.stationSetSha256,
    stationLineMappingSha256: stationContext.stationLineMappingSha256,
    queryPlanSha256: sha256(canonicalJson(normalizedSnapshot.queryPlan)),
    coverageScopeSha256: sha256(canonicalJson(normalizedSnapshot.coverage)),
    mappingContractVersion: facilityAdmission.candidate.mappingContractVersion,
    decision: "APPROVED",
    productionUseAllowed: true,
    approvedAt: new Date(observedAt).toISOString(),
    provenanceId: providerSnapshotRawSha256,
    licenseId: source.admissionEvidence.licenseEvidenceHash,
    providerSnapshotDigest: providerSnapshot.snapshotDigest,
    providerSnapshotRawSha256,
    providerCollectionPlanDigest: providerSnapshot.collectionPlanDigest,
    providerQueryPlanSha256: providerSnapshot.queryPlanSha256,
    facilityAdmissionDigest: facilityAdmission.admissionDigest,
    facilityStationLineMappingSha256: facilityAdmission.stationLineMappingSha256,
  });
  const admission = buildExitPathAdmission({
    candidate: facilityAdmission.candidate,
    observedAt: input.observedAt,
    sourceAdmission,
    sourceSnapshots: selectedSnapshots,
    stationLines: stationContext.stationLines,
    stationLineMappingSha256: stationContext.stationLineMappingSha256,
    stationLineSetSha256: facilityAdmission.stationLineSetSha256,
    snapshotBytes: normalizedSnapshotBytes,
  });
  return { normalizedSnapshot, admission };
}

export async function main(argv, { log = console.log } = {}) {
  const args = parseArgs(argv);
  await outputMustBeAbsent(args.outputDirectory);
  const [collection, facility, candidate, inventory, sourceSnapshots] = await Promise.all([
    args.collectionBundle
      ? consumeCurrentKricExitCollectionBundle({
        collectionBundle: args.collectionBundle,
        expectedBundleSha256: args.expectedBundleSha256,
        expectedRepositorySha: args.expectedRepositorySha,
        expectedWorkflowRunId: args.expectedWorkflowRunId,
      })
      : Promise.all([
        readRegularSnapshot(args.providerSnapshot, "provider snapshot"),
        readRegularSnapshot(args.collectionPlan, "collection plan"),
      ]).then(([provider, collectionPlan]) => ({
        providerSnapshotBytes: provider.bytes,
        collectionPlanBytes: collectionPlan.bytes,
      })),
    readRegularSnapshot(args.facilityAdmission, "facility admission"),
    readRegularSnapshot(args.candidateBuildSpec, "candidate build spec"),
    readRegularSnapshot(args.sourceInventory, "source inventory"),
    readRegularSnapshot(args.sourceSnapshots, "source snapshots"),
  ]);
  const result = buildCurrentExitPathSourceAdmission({
    providerSnapshotBytes: collection.providerSnapshotBytes,
    collectionPlan: parseJson(collection.collectionPlanBytes, "collection plan"),
    facilityAdmission: parseJson(facility.bytes, "facility admission"),
    candidateBuildSpec: parseJson(candidate.bytes, "candidate build spec"),
    sourceInventory: parseJson(inventory.bytes, "source inventory"),
    sourceSnapshots: parseJson(sourceSnapshots.bytes, "source snapshots"),
    observedAt: args.observedAt,
  });
  await publishDirectory({ outputDirectory: args.outputDirectory, result });
  log(JSON.stringify({
    result: result.admission.decision,
    admissionDigest: result.admission.admissionDigest,
    providerSnapshotDigest: result.admission.sourceIdentity.providerSnapshotDigest,
    stationLineCount: result.admission.cells.length,
    stateSummary: result.admission.stateSummary,
  }));
  return result;
}

function validateProviderSnapshot(bytes, observedAt) {
  const value = parseJson(bytes, "provider snapshot");
  assertKeys(value, PROVIDER_SNAPSHOT_KEYS, "provider snapshot keys");
  const canonical = canonicalKricExitPathProviderSnapshotJson(value);
  if (!bytes.equals(Buffer.from(canonical))) throw new Error("provider snapshot must be canonical JSON");
  if (value.schemaVersion !== 1 || value.artifactKind !== "kric-exit-path-provider-snapshot"
    || value.sourceId !== SOURCE_ID || value.credentialRedacted !== true) {
    throw new Error("provider snapshot identity mismatch");
  }
  for (const key of ["snapshotDigest", "collectionPlanDigest", "queryPlanSha256"]) {
    assertSha256(value[key], `provider snapshot ${key}`);
  }
  const capturedAt = requiredUtcInstant(value.capturedAt, "provider snapshot capturedAt");
  const freshUntil = requiredUtcInstant(value.freshUntil, "provider snapshot freshUntil");
  if (capturedAt > observedAt || freshUntil <= capturedAt) throw new Error("provider snapshot time mismatch");
  if (!value.coverage || value.coverage.requestPlanComplete !== true
    || !Array.isArray(value.coverage.queryIds)) {
    throw new Error("provider snapshot coverage mismatch");
  }
  const queryPlan = validateQueries(value.queryPlan);
  if (sha256(canonicalJson(queryPlan)) !== value.queryPlanSha256) {
    throw new Error("provider snapshot query plan mismatch");
  }
  const queryIds = queryPlan.map(({ queryId }) => queryId);
  if (canonicalJson(value.coverage.queryIds) !== canonicalJson(queryIds)) {
    throw new Error("provider snapshot coverage mismatch");
  }
  const results = validateProviderResults(value.results, queryIds);
  return canonicalObject({ ...value, queryPlan, results });
}

function validateCollectionPlan(value, providerSnapshot) {
  assertKeys(value, COLLECTION_PLAN_KEYS, "collection plan keys");
  canonicalKricExitPathCollectionPlanJson(value);
  if (value.schemaVersion !== 1 || value.artifactKind !== "kric-exit-path-collection-plan"
    || value.collectionPlanDigest !== providerSnapshot.collectionPlanDigest
    || value.queryPlanSha256 !== providerSnapshot.queryPlanSha256
    || canonicalJson(value.queryPlan) !== canonicalJson(providerSnapshot.queryPlan)) {
    throw new Error("collection plan identity mismatch");
  }
  assertKeys(value.candidate, COLLECTION_CANDIDATE_KEYS, "collection plan candidate keys");
  for (const key of COLLECTION_CANDIDATE_KEYS.slice(1)) {
    assertSha256(value.candidate[key], `collection plan candidate ${key}`);
  }
  if (!Array.isArray(value.providerMappings) || !Array.isArray(value.stationLineQueries)
    || value.providerMappings.length === 0 || value.stationLineQueries.length === 0) {
    throw new Error("collection plan station-line inventory mismatch");
  }
  const providerMappings = value.providerMappings.map((mapping) => {
    assertKeys(mapping, PROVIDER_MAPPING_KEYS, "collection plan provider mapping keys");
    for (const key of PROVIDER_MAPPING_KEYS) assertNonBlank(mapping[key], `collection plan provider mapping ${key}`);
    return canonicalObject(mapping);
  });
  const stationLineQueries = value.stationLineQueries.map((entry) => {
    assertKeys(entry, ["stationLineId", "queryIds"], "collection plan station-line query keys");
    assertNonBlank(entry.stationLineId, "collection plan station-line id");
    if (!Array.isArray(entry.queryIds) || entry.queryIds.length === 0
      || entry.queryIds.some((queryId) => typeof queryId !== "string" || !/^[a-f0-9]{64}$/.test(queryId))) {
      throw new Error("collection plan station-line query inventory mismatch");
    }
    return canonicalObject(entry);
  });
  if (new Set(providerMappings.map(({ stationId, lineId }) => `${stationId}\0${lineId}`)).size
      !== providerMappings.length
    || new Set(stationLineQueries.map(({ stationLineId }) => stationLineId)).size
      !== stationLineQueries.length) {
    throw new Error("collection plan station-line inventory mismatch");
  }
  return canonicalObject({ ...value, providerMappings, stationLineQueries });
}

function validateQueries(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("provider snapshot query plan mismatch");
  const seenQueries = new Set();
  const seenTuples = new Set();
  const queries = value.map((query) => {
    assertKeys(query, QUERY_KEYS, "provider query keys");
    for (const key of QUERY_KEYS) assertNonBlank(query[key], `provider query ${key}`);
    const identity = canonicalObject({
      providerLineId: query.providerLineId,
      providerNextStationId: query.providerNextStationId,
      providerOperatorId: query.providerOperatorId,
      providerStationId: query.providerStationId,
      routeEdgeId: query.routeEdgeId,
    });
    if (query.queryId !== sha256(canonicalJson(identity))) throw new Error("provider query identity mismatch");
    if (seenQueries.has(query.queryId)) throw new Error("duplicate provider query");
    seenQueries.add(query.queryId);
    const tuple = [
      query.providerOperatorId, query.providerLineId, query.providerStationId, query.providerNextStationId,
    ].join("\0");
    if (seenTuples.has(tuple)) throw new Error("duplicate provider query tuple");
    seenTuples.add(tuple);
    return canonicalObject(query);
  });
  if (canonicalJson(queries) !== canonicalJson([...queries].sort(compareQueries))) {
    throw new Error("provider query order mismatch");
  }
  return queries;
}

function validateProviderResults(value, queryIds) {
  if (!Array.isArray(value) || value.length !== queryIds.length) {
    throw new Error("provider result coverage mismatch");
  }
  return value.map((result, index) => {
    assertKeys(result, PROVIDER_RESULT_KEYS, "provider result keys");
    if (result.queryId !== queryIds[index] || !PROVIDER_STATES.has(result.state)) {
      throw new Error("provider result identity mismatch");
    }
    assertSha256(result.rawResponseSha256, "provider raw response sha256");
    assertSha256(result.providerRecordHash, "provider record hash");
    if (!Number.isSafeInteger(result.rawResponseByteSize) || result.rawResponseByteSize < 1
      || result.rawResponseByteSize > 1024 * 1024 || !Array.isArray(result.rows)) {
      throw new Error("provider result shape mismatch");
    }
    const rows = result.rows.map(validateProviderRow);
    if (sha256(canonicalJson(rows)) !== result.providerRecordHash) {
      throw new Error("provider record inventory mismatch");
    }
    const shapeMatches = (result.state === "ROWS_OBSERVED"
      && result.providerResultCode === "00" && rows.length > 0)
      || (result.state === "EXPLICIT_ZERO"
        && result.providerResultCode === "00" && rows.length === 0)
      || (result.state === "PROVIDER_NO_DATA"
        && result.providerResultCode === "03" && rows.length === 0)
      || (result.state === "PROVIDER_RESULT_UNVERIFIED"
        && result.providerResultCode === null);
    if (!shapeMatches) throw new Error("provider result state mismatch");
    return canonicalObject({ ...result, rows });
  });
}

function validateProviderRow(row) {
  assertKeys(row, PROVIDER_ROW_KEYS, "provider row keys");
  for (const key of PROVIDER_ROW_KEYS) {
    const value = row[key];
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error("provider row scalar mismatch");
    }
  }
  return canonicalObject(row);
}

function validateFacilityAdmission(value) {
  canonicalFacilitySourceAdmissionJson(value);
  if (value.artifactKind !== "facility-source-admission-matrix" || value.decision !== "GO"
    || !Array.isArray(value.cells) || value.cells.length === 0
    || !Array.isArray(value.queryPartition?.joined)) {
    throw new Error("facility admission identity mismatch");
  }
  return value;
}

function validateCandidateBuildSpec(value, candidate, sourceSnapshots) {
  if (value?.schemaVersion !== 1 || value.artifactKind !== "datapack-candidate-build-spec"
    || value.candidateId !== candidate.candidateId || !Array.isArray(value.sourceSnapshots)
    || !Array.isArray(value.sourceSnapshotIds) || !Array.isArray(sourceSnapshots)) {
    throw new Error("candidate identity mismatch");
  }
  assertSha256(value.sourceSnapshotSetHash, "candidate source snapshot set hash");
  if (value.sourceSnapshotIds.length !== value.sourceSnapshots.length) {
    throw new Error("source snapshot set identity mismatch");
  }
  const selectedSnapshots = value.sourceSnapshotIds.map((snapshotId, index) => {
    const matches = sourceSnapshots.filter((entry) => entry?.snapshotId === snapshotId);
    if (matches.length !== 1) throw new Error("source snapshot set identity mismatch");
    const [selected] = matches;
    const projection = value.sourceSnapshots[index];
    for (const key of [
      "snapshotId", "sourceId", "rawObjectUri", "rawSha256", "schemaFingerprint",
      "licenseStatus", "redistributionAllowed", "snapshotStatus", "credentialRedacted",
    ]) {
      if (projection?.[key] !== selected[key]) throw new Error("source snapshot set identity mismatch");
    }
    return selected;
  });
  if (value.sourceSnapshotSetHash !== candidate.sourceSetSha256
    || sha256(JSON.stringify(selectedSnapshots)) !== value.sourceSnapshotSetHash) {
    throw new Error("source snapshot set identity mismatch");
  }
  return { candidateBuildSpec: value, selectedSnapshots };
}

function validateSourceInventory(value) {
  if (!Array.isArray(value?.sources)) throw new Error("source inventory mismatch");
  const matches = value.sources.filter(({ id }) => id === SOURCE_ID);
  if (matches.length !== 1) throw new Error("source inventory identity mismatch");
  const [source] = matches;
  for (const key of ["owner", "provider", "providerDepartment", "sourceSystem", "datasetUrl", "datasetKind"]) {
    assertNonBlank(source[key], `source ${key}`);
  }
  const license = source.license;
  if (!license || license.commercialUseAllowed !== true || license.derivativeWorkAllowed !== true
    || license.redistributionAllowed !== true) {
    throw new Error("source license mismatch");
  }
  for (const key of ["type", "name", "attribution", "evidenceUrl"]) assertNonBlank(license[key], `source license ${key}`);
  assertKeys(source.coverageScope, SOURCE_COVERAGE_KEYS, "source coverage scope keys");
  for (const key of SOURCE_COVERAGE_KEYS) {
    const values = source.coverageScope[key];
    if (!Array.isArray(values) || values.length === 0
      || values.some((value) => typeof value !== "string" || value.trim() === "")
      || new Set(values).size !== values.length) {
      throw new Error("source coverage scope mismatch");
    }
  }
  if (!source.coverageScope.regionIds.includes("capital")
    || !source.coverageScope.sourceDomains.includes("indoor_movement_paths")
    || source.admissionEvidence?.decision !== "APPROVED") {
    throw new Error("source admission evidence mismatch");
  }
  assertSha256(source.admissionEvidence.licenseEvidenceHash, "source license evidence hash");
  return source;
}

function buildStationContext(facilityAdmission, collectionPlan, sourceCoverage) {
  const candidate = facilityAdmission.candidate;
  const queryPlan = collectionPlan.queryPlan;
  const queryById = new Map(queryPlan.map((query) => [query.queryId, query]));
  const providerMappingByStationLine = new Map(collectionPlan.providerMappings.map((mapping) => [
    `${mapping.stationId}:${mapping.lineId}`, mapping,
  ]));
  const queryIdsByStationLine = new Map(collectionPlan.stationLineQueries.map((entry) => [
    entry.stationLineId, entry.queryIds,
  ]));
  for (const key of ["candidateId", "mappingContractVersion", "materializerVersion"]) {
    assertNonBlank(candidate[key], `candidate ${key}`);
  }
  for (const key of ["stationSetSha256", "sourceSetSha256"]) assertSha256(candidate[key], `candidate ${key}`);
  assertSha256(facilityAdmission.stationLineSetSha256, "station-line set sha256");
  assertSha256(facilityAdmission.stationLineMappingSha256, "station-line mapping sha256");
  const cellByStationLine = new Map();
  for (const cell of facilityAdmission.cells) {
    for (const key of ["stationId", "lineId", "operatorId"]) assertNonBlank(cell[key], `facility cell ${key}`);
    if (cell.candidateId !== candidate.candidateId || cell.stationSetSha256 !== candidate.stationSetSha256
      || cell.sourceSetSha256 !== candidate.sourceSetSha256
      || !String(cell.state).startsWith("ADMITTED_FACILITY_")) {
      throw new Error("facility candidate identity mismatch");
    }
    const key = `${cell.stationId}\0${cell.lineId}`;
    if (cellByStationLine.has(key)) throw new Error("duplicate facility station-line");
    cellByStationLine.set(key, cell);
  }
  const stationLines = [];
  const queries = [];
  for (const [stationLineKey, cell] of cellByStationLine) {
    const stationLineId = `${cell.stationId}:${cell.lineId}`;
    const providerMapping = providerMappingByStationLine.get(stationLineId);
    const queryIds = queryIdsByStationLine.get(stationLineId);
    const tupleCandidates = facilityAdmission.queryPartition.joined.filter((entry) =>
      entry.stationId === cell.stationId && entry.lineId === cell.lineId);
    if (!providerMapping || tupleCandidates.length !== 1
      || tupleCandidates[0].providerOperatorId !== providerMapping.providerOperatorId
      || tupleCandidates[0].providerLineId !== providerMapping.providerLineId
      || tupleCandidates[0].providerStationId !== providerMapping.providerStationId) {
      throw new Error(`current EXIT provider mapping mismatch: ${stationLineKey}`);
    }
    const matchingQueries = (queryIds ?? []).map((queryId) => queryById.get(queryId));
    if (matchingQueries.some((query) => query === undefined)) {
      throw new Error(`current EXIT station-line query inventory mismatch: ${stationLineKey}`);
    }
    if (matchingQueries.length === 0) throw new Error(`current EXIT station-line query missing: ${stationLineKey}`);
    if (matchingQueries.some((query) => query.providerOperatorId !== providerMapping.providerOperatorId
      || query.providerLineId !== providerMapping.providerLineId
      || query.providerStationId !== providerMapping.providerStationId)) {
      throw new Error(`current EXIT provider mapping mismatch: ${stationLineKey}`);
    }
    const nameIdentities = new Map(matchingQueries.map((query) => [canonicalJson({
      operatorName: query.operatorName,
      lineName: query.lineName,
      stationName: query.stationName,
      regionId: query.regionId,
    }), query]));
    if (nameIdentities.size !== 1) throw new Error(`current EXIT station-line query ambiguous: ${stationLineKey}`);
    const query = nameIdentities.values().next().value;
    if (!sourceCoverage.regionIds.includes(query.regionId)
      || !sourceCoverage.operatorIds.includes(cell.operatorId)) {
      throw new Error(`current EXIT source coverage mismatch: ${stationLineKey}`);
    }
    stationLines.push(canonicalObject({
      stationId: cell.stationId,
      stationName: query.stationName,
      stationAliases: [],
      regionId: query.regionId,
      lineId: cell.lineId,
      lineName: query.lineName,
      operatorId: cell.operatorId,
      operatorName: query.operatorName,
    }));
    queries.push(...matchingQueries);
  }
  stationLines.sort(compareStationLines);
  const uniqueQueries = new Map(queries.map((query) => [query.queryId, query]));
  const orderedQueries = [...uniqueQueries.values()].sort(compareQueries);
  const stationIds = [...new Set(stationLines.map(({ stationId }) => stationId))].sort(compareBytes);
  const stationLineSet = stationLines.map(({ stationId, lineId, operatorId }) => canonicalObject({
    stationId, lineId, operatorId,
  }));
  const stationLineMappingSha256 = sha256(canonicalJson(stationLines));
  if (sha256(canonicalJson(stationIds)) !== candidate.stationSetSha256
    || sha256(canonicalJson(stationLineSet)) !== facilityAdmission.stationLineSetSha256) {
    throw new Error("facility station-line mapping mismatch");
  }
  return { stationLines, queries: orderedQueries, stationLineMappingSha256 };
}

function normalizeResult(result) {
  if (!result) throw new Error("current EXIT provider result missing");
  if (result.state === "ROWS_OBSERVED") {
    const recordId = result.providerRecordHash;
    const record = canonicalObject({ recordId, classification: "EXIT_TO_PLATFORM_PATH" });
    return canonicalObject({
      queryId: result.queryId,
      state: "OBSERVED_EXIT_PATH",
      records: [{ ...record, providerRecordHash: sha256(canonicalJson(record)) }],
      zeroEvidenceSha256: null,
    });
  }
  if (result.state === "EXPLICIT_ZERO") {
    return canonicalObject({
      queryId: result.queryId,
      state: "EXPLICIT_ZERO",
      records: [],
      zeroEvidenceSha256: result.rawResponseSha256,
    });
  }
  return canonicalObject({
    queryId: result.queryId,
    state: result.state === "PROVIDER_NO_DATA" ? "PROVIDER_NO_DATA" : "FAILED",
    records: [],
    zeroEvidenceSha256: null,
  });
}

async function publishDirectory({ outputDirectory, result }) {
  const parent = path.dirname(outputDirectory);
  const parentBefore = await lstat(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) throw new Error("output parent must be a directory");
  const staging = await mkdtemp(path.join(parent, ".current-exit-admission-"));
  try {
    await Promise.all([
      writeFile(path.join(staging, NORMALIZED_FILE), Buffer.from(canonicalJson(result.normalizedSnapshot)), {
        flag: "wx", mode: 0o600,
      }),
      writeFile(path.join(staging, ADMISSION_FILE), Buffer.from(canonicalExitPathAdmissionJson(result.admission)), {
        flag: "wx", mode: 0o600,
      }),
    ]);
    await outputMustBeAbsent(outputDirectory);
    const parentAfter = await lstat(parent);
    if (!sameIdentity(parentBefore, parentAfter)) throw new Error("output parent changed during build");
    await rename(staging, outputDirectory);
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

function parseArgs(argv) {
  const commonPathFlags = new Set([
    "facility-admission", "candidate-build-spec", "source-inventory", "source-snapshots", "output-directory",
  ]);
  const explicitPathFlags = new Set(["provider-snapshot", "collection-plan"]);
  const bundlePathFlags = new Set(["collection-bundle"]);
  const allowed = new Set([
    ...commonPathFlags, ...explicitPathFlags, ...bundlePathFlags,
    "observed-at", "expected-bundle-sha256", "expected-repository-sha", "expected-workflow-run-id",
  ]);
  if (!Array.isArray(argv) || argv.length % 2 !== 0) throw new Error("current EXIT admission arguments mismatch");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = String(argv[index] ?? "").replace(/^--/, "");
    const value = argv[index + 1];
    if (!allowed.has(flag) || values[flag] !== undefined || typeof value !== "string" || value === "") {
      throw new Error("current EXIT admission arguments mismatch");
    }
    values[flag] = commonPathFlags.has(flag) || explicitPathFlags.has(flag) || bundlePathFlags.has(flag)
      ? requiredAbsolutePath(value, `--${flag}`)
      : value;
  }
  for (const flag of [...commonPathFlags, "observed-at", "output-directory"]) {
    if (values[flag] === undefined) throw new Error("current EXIT admission arguments mismatch");
  }
  const explicit = [...explicitPathFlags].filter((flag) => values[flag] !== undefined).length;
  const bundle = values["collection-bundle"] !== undefined;
  if ((explicit !== 2 && !bundle) || (explicit !== 0 && bundle)
    || (bundle && (values["expected-bundle-sha256"] === undefined || values["expected-repository-sha"] === undefined || values["expected-workflow-run-id"] === undefined))
    || (!bundle && (values["expected-bundle-sha256"] !== undefined || values["expected-repository-sha"] !== undefined || values["expected-workflow-run-id"] !== undefined))) {
    throw new Error("current EXIT admission arguments mismatch");
  }
  requiredUtcInstant(values["observed-at"], "--observed-at");
  if (bundle) {
    if (!/^[a-f0-9]{64}$/.test(values["expected-bundle-sha256"])) {
      throw new Error("expected bundle SHA mismatch");
    }
    if (!/^[a-f0-9]{40}$/.test(values["expected-repository-sha"])) {
      throw new Error("expected repository SHA mismatch");
    }
    if (!/^[1-9][0-9]*$/.test(values["expected-workflow-run-id"])) {
      throw new Error("expected workflow run ID mismatch");
    }
  }
  return {
    providerSnapshot: values["provider-snapshot"],
    collectionPlan: values["collection-plan"],
    facilityAdmission: values["facility-admission"],
    candidateBuildSpec: values["candidate-build-spec"],
    sourceInventory: values["source-inventory"],
    sourceSnapshots: values["source-snapshots"],
    outputDirectory: values["output-directory"],
    observedAt: values["observed-at"],
    collectionBundle: values["collection-bundle"],
    expectedBundleSha256: values["expected-bundle-sha256"],
    expectedRepositorySha: values["expected-repository-sha"],
    expectedWorkflowRunId: bundle ? Number(values["expected-workflow-run-id"]) : undefined,
  };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} must be strict UTF-8 JSON`);
  }
}

function requireBytes(value, label) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error(`${label} must be non-empty bytes`);
  return Buffer.from(value);
}

function requiredAbsolutePath(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

async function outputMustBeAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output directory must be absent");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} mismatch`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (canonicalJson(actual) !== canonicalJson(wanted)) throw new Error(`${label} mismatch`);
}

function assertNonBlank(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be non-blank`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be sha256`);
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
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

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "current EXIT admission failed");
    process.exitCode = 1;
  });
}
