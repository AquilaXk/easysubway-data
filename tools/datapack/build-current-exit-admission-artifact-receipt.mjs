#!/usr/bin/env node
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalExitPathAdmissionJson } from "./build-exit-path-admission.mjs";
import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";

const NORMALIZED = "exit-path-normalized-source-snapshot.json";
const ADMISSION = "exit-path-source-admission.json";
const RECEIPT = "exit-path-admission-artifact-receipt.json";
const RECEIPT_KEYS = ["schemaVersion", "artifactKind", "repository", "admissionWorkflowRunId", "providerWorkflowRunId", "headSha", "artifactId", "artifactName", "artifactArchiveSha256", "normalizedSnapshotSha256", "admissionSha256", "admissionDigest", "receiptSha256"];
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const QUERY_KEYS = ["queryId", "routeEdgeId", "providerOperatorId", "providerLineId", "providerStationId", "providerNextStationId", "operatorName", "lineName", "stationName", "regionId"];
const RESULT_KEYS = ["queryId", "state", "records", "zeroEvidenceSha256", "providerResponseSha256"];
const RECORD_KEYS = ["recordId", "classification", "providerRecordHash"];
const PROVIDER_KEYS = ["sourceId", "snapshotId", "capturedAt", "freshUntil", "snapshotDigest", "rawSha256", "collectionPlanDigest", "queryPlanSha256"];
const SOURCE_KEYS = ["sourceId", "snapshotId", "rawSha256", "capturedAt", "freshUntil", "queryPlanSha256", "coverageScopeSha256", "approvedAt", "decision", "productionUseAllowed", "provenanceId", "licenseId", "providerSnapshotDigest", "providerSnapshotRawSha256", "providerCollectionPlanDigest", "providerQueryPlanSha256", "facilityAdmissionDigest", "facilityStationLineMappingSha256"];
const TERMINAL_STATE = "ADMITTED_EXIT_UNVERIFIED_BLOCKED";
const TERMINAL_POLICY = "PROVIDER_NO_DATA_RESULT_03_BLOCKED";
const TERMINAL_REASON = "출구 이동경로가 검증되지 않아 경로를 차단했습니다.";

export function buildCurrentExitAdmissionArtifactReceipt(input) {
  assertKeys(input, ["artifactArchiveBytes", "repository", "admissionWorkflowRunId", "providerWorkflowRunId", "headSha", "artifactId", "artifactName", "artifactArchiveSha256"], "receipt input");
  const archive = bytes(input.artifactArchiveBytes, "artifact archive");
  if (input.repository !== "AquilaXk/easysubway-data" || !/^[a-f0-9]{40}$/.test(input.headSha)
    || !safeId(input.admissionWorkflowRunId) || !safeId(input.providerWorkflowRunId) || !safeId(input.artifactId)
    || input.artifactName !== `kric-exit-path-source-admission-${input.providerWorkflowRunId}`
    || input.artifactArchiveSha256 !== sha256(archive)) throw new Error("artifact receipt metadata mismatch");
  assertSha(input.artifactArchiveSha256, "artifact archive SHA");
  const files = readRootRegularEntries(archive);
  const normalized = files.get(NORMALIZED); const admission = files.get(ADMISSION);
  validatePair(normalized, admission);
  const payload = canonicalObject({
    schemaVersion: 1, artifactKind: "current-exit-admission-artifact-receipt", repository: input.repository,
    admissionWorkflowRunId: input.admissionWorkflowRunId, providerWorkflowRunId: input.providerWorkflowRunId,
    headSha: input.headSha, artifactId: input.artifactId, artifactName: input.artifactName,
    artifactArchiveSha256: input.artifactArchiveSha256, normalizedSnapshotSha256: sha256(normalized),
    admissionSha256: sha256(admission), admissionDigest: JSON.parse(admission).admissionDigest,
  });
  return canonicalObject({ ...payload, receiptSha256: sha256(canonicalJson(payload)) });
}

export function canonicalCurrentExitAdmissionArtifactReceiptJson(receipt) {
  assertKeys(receipt, RECEIPT_KEYS, "receipt keys");
  const { receiptSha256, ...payload } = receipt;
  if (receipt.schemaVersion !== 1 || receipt.artifactKind !== "current-exit-admission-artifact-receipt"
    || receipt.repository !== "AquilaXk/easysubway-data" || !safeId(receipt.admissionWorkflowRunId)
    || !safeId(receipt.providerWorkflowRunId) || !safeId(receipt.artifactId)
    || !/^[a-f0-9]{40}$/.test(receipt.headSha)
    || receipt.artifactName !== `kric-exit-path-source-admission-${receipt.providerWorkflowRunId}`) throw new Error("receipt identity mismatch");
  for (const key of ["artifactArchiveSha256", "normalizedSnapshotSha256", "admissionSha256", "admissionDigest", "receiptSha256"]) assertSha(receipt[key], key);
  if (sha256(canonicalJson(payload)) !== receiptSha256) throw new Error("receipt digest mismatch");
  return canonicalJson(receipt);
}

export async function main(argv, { log = console.log } = {}) {
  const args = parseArgs(argv); await absent(args.outputDirectory, "output directory");
  const snapshot = await readRegularSnapshot(args.artifactArchive, "artifact archive");
  const { artifactArchive, outputDirectory, ...receiptArgs } = args;
  const receipt = buildCurrentExitAdmissionArtifactReceipt({ ...receiptArgs, artifactArchiveBytes: snapshot.bytes });
  await unchanged(snapshot);
  const finalSnapshot = await readRegularSnapshot(args.artifactArchive, "artifact archive");
  if (!sameSnapshot(snapshot, finalSnapshot) || !finalSnapshot.bytes.equals(snapshot.bytes)) throw new Error("artifact archive changed before publish");
  const files = readRootRegularEntries(finalSnapshot.bytes);
  await publish(args.outputDirectory, files, Buffer.from(canonicalCurrentExitAdmissionArtifactReceiptJson(receipt)));
  log(JSON.stringify({ result: "PASS", receiptSha256: receipt.receiptSha256 }));
  return receipt;
}

function validatePair(normalizedBytes, admissionBytes) {
  const normalized = parseCanonical(normalizedBytes, "normalized snapshot");
  const admission = parseCanonical(admissionBytes, "admission");
  validateNormalized(normalized);
  if (Buffer.from(canonicalExitPathAdmissionJson(admission)).compare(admissionBytes) !== 0 || admission.decision !== "GO") throw new Error("admission must be canonical GO");
  if (normalized.schemaVersion !== 4 || normalized.artifactKind !== "exit-path-normalized-source-snapshot"
    || admission.schemaVersion !== 2
    || !normalized.coverage || normalized.coverage.exhaustive !== true
    || !Array.isArray(normalized.coverage.queryIds) || !Array.isArray(normalized.queryPlan) || !Array.isArray(normalized.results)
    || normalized.coverage.queryIds.length !== 420 || normalized.queryPlan.length !== 420 || normalized.results.length !== 420
    || !Array.isArray(admission.cells) || admission.cells.length !== 213 || new Set(admission.cells.map(({ stationId }) => stationId)).size !== 199) throw new Error("EXIT denominator mismatch");
  const planIds = normalized.queryPlan.map(({ queryId }) => queryId);
  const resultIds = normalized.results.map(({ queryId }) => queryId);
  const coverageIds = normalized.coverage.queryIds;
  if (new Set(planIds).size !== 420 || new Set(resultIds).size !== 420 || new Set(coverageIds).size !== 420
    || canonicalJson([...coverageIds].sort(compare)) !== canonicalJson(coverageIds)
    || canonicalJson([...resultIds].sort(compare)) !== canonicalJson(resultIds)
    || !sameSet(planIds, coverageIds) || !sameSet(planIds, resultIds)) throw new Error("normalized query coverage mismatch");
  const source = admission.sourceIdentity; const provider = normalized.providerSnapshotIdentity;
  assertKeys(source, SOURCE_KEYS, "admission source identity keys");
  for (const key of ["rawSha256", "queryPlanSha256", "coverageScopeSha256", "provenanceId", "licenseId", "providerSnapshotDigest", "providerSnapshotRawSha256", "providerCollectionPlanDigest", "providerQueryPlanSha256", "facilityAdmissionDigest", "facilityStationLineMappingSha256"]) assertSha(source[key], "admission source hash");
  if (source.decision !== "APPROVED" || source.productionUseAllowed !== true) throw new Error("admission source identity mismatch");
  if (!source || !provider || source.rawSha256 !== sha256(normalizedBytes) || source.sourceId !== normalized.sourceId
    || source.snapshotId !== normalized.snapshotId || source.capturedAt !== normalized.capturedAt || source.freshUntil !== normalized.freshUntil
    || source.providerSnapshotDigest !== provider.snapshotDigest || source.providerSnapshotRawSha256 !== provider.rawSha256
    || source.providerCollectionPlanDigest !== provider.collectionPlanDigest || source.providerQueryPlanSha256 !== provider.queryPlanSha256
    || source.queryPlanSha256 !== sha256(canonicalJson(normalized.queryPlan))
    || admission.normalizedEvidenceSha256 !== sha256(canonicalJson({ coverage: normalized.coverage, queryPlan: normalized.queryPlan, results: normalized.results }))) throw new Error("EXIT source/provider binding mismatch");
  validateAdmissionContract(admission, normalized, planIds, resultIds);
}

function validateAdmissionContract(admission, normalized, planIds, resultIds) {
  assertKeys(admission.candidate, ["candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion"], "admission candidate");
  for (const key of ["candidateId", "mappingContractVersion", "materializerVersion"]) if (typeof admission.candidate[key] !== "string" || admission.candidate[key] === "") throw new Error("admission candidate mismatch");
  for (const key of ["stationSetSha256", "sourceSetSha256"]) assertSha(admission.candidate[key], "admission candidate hash");
  const cells = admission.cells; if (!Array.isArray(cells) || cells.length !== 213) throw new Error("EXIT cell denominator mismatch");
  const stationLineIds = new Set(); const stationIds = new Set(); const allowed = new Set(["ADMITTED_EXIT_PATH", "ADMITTED_VERIFIED_ABSENCE", TERMINAL_STATE]);
  for (const cell of cells) {
    assertKeys(cell, ["candidateId", "stationSetSha256", "sourceSetSha256", "stationLineMappingSha256", "stationLineSetSha256", "stationLineId", "stationId", "lineId", "operatorId", "domain", "sourceId", "sourceSnapshotId", "evidenceRawSha256", "capturedAt", "freshUntil", "provenanceId", "licenseId", "mappingContractVersion", "materializerVersion", "normalizedEvidenceSha256", "state", "admissionReason", "providerRecordHash", "providerResponseSha256"], "admission cell");
    if (cell.stationLineId !== `${cell.stationId}:${cell.lineId}` || stationLineIds.has(cell.stationLineId) || !allowed.has(cell.state)
      || cell.candidateId !== admission.candidate.candidateId || cell.stationSetSha256 !== admission.candidate.stationSetSha256 || cell.sourceSetSha256 !== admission.candidate.sourceSetSha256
      || cell.stationLineMappingSha256 !== admission.stationLineMappingSha256 || cell.stationLineSetSha256 !== admission.stationLineSetSha256
      || cell.sourceId !== normalized.sourceId || cell.sourceSnapshotId !== normalized.snapshotId || cell.evidenceRawSha256 !== admission.sourceIdentity.rawSha256
      || cell.capturedAt !== admission.sourceIdentity.capturedAt || cell.freshUntil !== admission.sourceIdentity.freshUntil
      || cell.provenanceId !== admission.sourceIdentity.provenanceId || cell.licenseId !== admission.sourceIdentity.licenseId
      || cell.mappingContractVersion !== admission.candidate.mappingContractVersion || cell.materializerVersion !== admission.candidate.materializerVersion || cell.normalizedEvidenceSha256 !== admission.normalizedEvidenceSha256 || cell.domain !== "EXIT"
      || !/^[a-f0-9]{64}$/.test(cell.providerRecordHash)
      || (cell.state === TERMINAL_STATE
        ? cell.admissionReason !== "PROVIDER_NO_DATA_UNVERIFIED_BLOCKED" || !/^[a-f0-9]{64}$/.test(cell.providerResponseSha256)
        : !["OFFICIAL_EXIT_PATH_PRESENT", "OFFICIAL_EXIT_EXPLICIT_ZERO"].includes(cell.admissionReason) || cell.providerResponseSha256 !== null)) throw new Error("admission cell binding mismatch");
    stationLineIds.add(cell.stationLineId); stationIds.add(cell.stationId);
  }
  const lineSet = cells.map(({ stationId, lineId, operatorId }) => ({ stationId, lineId, operatorId })).sort((left, right) => compare(left.stationId, right.stationId) || compare(left.lineId, right.lineId) || compare(left.operatorId, right.operatorId));
  if (stationLineIds.size !== 213 || stationIds.size !== 199 || admission.candidate.stationSetSha256 !== sha256(canonicalJson([...stationIds].sort(compare))) || admission.stationLineSetSha256 !== sha256(canonicalJson(lineSet))) throw new Error("admission station denominator mismatch");
  if (!admission.queryPartition || !Array.isArray(admission.queryPartition.joined) || !Array.isArray(admission.queryPartition.unmatched) || !Array.isArray(admission.queryPartition.ambiguous)
    || admission.queryPartition.joined.length !== 420 || admission.queryPartition.unmatched.length !== 0 || admission.queryPartition.ambiguous.length !== 0
    || canonicalJson(admission.queryPartition.joined.map(({ queryId }) => queryId).sort(compare)) !== canonicalJson([...planIds].sort(compare))
    || canonicalJson(resultIds.sort(compare)) !== canonicalJson([...planIds].sort(compare)) || !admission.queryPartition.summary || canonicalJson(admission.queryPartition.summary) !== canonicalJson({ queryCount: 420, joinedCount: 420, unmatchedCount: 0, ambiguousCount: 0 })) throw new Error("admission query partition mismatch");
  const cellsById = new Map(cells.map((cell) => [cell.stationLineId, cell])); const resultById = new Map(normalized.results.map((result) => [result.queryId, result]));
  for (const joined of admission.queryPartition.joined) { assertKeys(joined, [...QUERY_KEYS, "stationLineId"], "admission joined query"); const { stationLineId, ...query } = joined; const expected = normalized.queryPlan.find(({ queryId }) => queryId === joined.queryId); if (!cellsById.has(stationLineId) || canonicalJson(query) !== canonicalJson(expected)) throw new Error("admission joined query mismatch"); }
  for (const cell of cells) {
    const joined = admission.queryPartition.joined.filter(({ stationLineId }) => stationLineId === cell.stationLineId);
    const results = joined.map(({ queryId }) => resultById.get(queryId));
    const expected = expectedCellOutcome(results, normalized.coverage.exhaustive);
    if (joined.length === 0 || cell.providerRecordHash !== sha256(canonicalJson(results))) throw new Error("admission cell result binding mismatch");
    if (cell.state !== expected.state || cell.admissionReason !== expected.admissionReason
      || cell.providerResponseSha256 !== expected.providerResponseSha256) throw new Error("admission cell outcome mismatch");
  }
  const summary = admission.stateSummary; const counts = Object.fromEntries(["ADMITTED_EXIT_PATH", "ADMITTED_VERIFIED_ABSENCE", "BLOCKED_WITH_EVIDENCE", "MISSING", "STALE", "UNKNOWN", TERMINAL_STATE].map((state) => [state, cells.filter((cell) => cell.state === state).length]));
  if (canonicalJson(summary) !== canonicalJson(counts) || !Array.isArray(admission.materializerEvidenceRows) || admission.materializerEvidenceRows.length !== cells.length || canonicalJson(admission.materializerEvidenceRows) !== canonicalJson(cells.map(materializerRow))) throw new Error("admission materializer mismatch");
}

function materializerRow(cell) {
  if (cell.state === TERMINAL_STATE) {
    const evidenceHash = sha256(canonicalJson({
      sourceSnapshotId: cell.sourceSnapshotId,
      stationId: cell.stationId,
      lineId: cell.lineId,
      operatorId: cell.operatorId,
      domain: "EXIT",
      terminalPolicy: TERMINAL_POLICY,
      providerResponseSha256: cell.providerResponseSha256,
    }));
    return canonicalObject({
      candidateId: cell.candidateId, stationSetSha256: cell.stationSetSha256, sourceSetSha256: cell.sourceSetSha256,
      stationId: cell.stationId, lineId: cell.lineId, operatorId: cell.operatorId, domain: "EXIT",
      state: "UNVERIFIED_EVIDENCE_BLOCKED", sourceId: cell.sourceId, sourceSnapshotId: cell.sourceSnapshotId,
      evidenceRawSha256: cell.evidenceRawSha256, providerRecordHash: null, capturedAt: cell.capturedAt,
      freshUntil: cell.freshUntil, provenanceId: cell.provenanceId, licenseId: cell.licenseId,
      mappingContractVersion: cell.mappingContractVersion, materializerVersion: cell.materializerVersion,
      evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED", evidenceReason: TERMINAL_REASON,
      terminalPolicy: TERMINAL_POLICY, providerResultCode: "03", strictRouteEligible: false,
      strictRouteEligibleReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED",
      statusMeaning: "PROVIDER_NO_DATA_NOT_ABSENCE", confidence: 0,
      providerResponseSha256: cell.providerResponseSha256, evidenceHash,
    });
  }
  const present = cell.state === "ADMITTED_EXIT_PATH";
  return canonicalObject({ candidateId: cell.candidateId, stationSetSha256: cell.stationSetSha256, sourceSetSha256: cell.sourceSetSha256, stationId: cell.stationId, lineId: cell.lineId, operatorId: cell.operatorId, domain: "EXIT", state: present ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT", sourceId: cell.sourceId, sourceSnapshotId: cell.sourceSnapshotId, evidenceRawSha256: cell.evidenceRawSha256, providerRecordHash: cell.providerRecordHash, capturedAt: cell.capturedAt, freshUntil: cell.freshUntil, provenanceId: cell.provenanceId, licenseId: cell.licenseId, mappingContractVersion: cell.mappingContractVersion, materializerVersion: cell.materializerVersion, evidenceKind: present ? "OBSERVED" : "EXPLICIT_ZERO", evidenceReason: cell.admissionReason });
}

function expectedCellOutcome(results, exhaustive) {
  if (results.some(({ state }) => state === "FAILED")) return { state: "BLOCKED_WITH_EVIDENCE", admissionReason: "PROVIDER_REQUEST_FAILED", providerResponseSha256: null };
  if (results.some(({ state }) => state === "PROVIDER_NO_DATA")) {
    const responses = results
      .filter(({ state }) => state === "PROVIDER_NO_DATA")
      .map(({ queryId, providerResponseSha256 }) => canonicalObject({ queryId, providerResponseSha256 }))
      .sort((left, right) => compare(left.queryId, right.queryId));
    return { state: TERMINAL_STATE, admissionReason: "PROVIDER_NO_DATA_UNVERIFIED_BLOCKED", providerResponseSha256: sha256(canonicalJson(responses)) };
  }
  if (results.some(({ state }) => state === "OBSERVED_EXIT_PATH")) return { state: "ADMITTED_EXIT_PATH", admissionReason: "OFFICIAL_EXIT_PATH_PRESENT", providerResponseSha256: null };
  if (results.every(({ state }) => state === "EXPLICIT_ZERO")) return exhaustive
    ? { state: "ADMITTED_VERIFIED_ABSENCE", admissionReason: "OFFICIAL_EXIT_EXPLICIT_ZERO", providerResponseSha256: null }
    : { state: "BLOCKED_WITH_EVIDENCE", admissionReason: "SOURCE_COVERAGE_PARTIAL", providerResponseSha256: null };
  throw new Error("unsupported EXIT station-line result aggregation");
}

function validateNormalized(value) {
  assertKeys(value, ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "freshUntil", "providerSnapshotIdentity", "coverage", "queryPlan", "results"], "normalized snapshot keys");
  if (value.schemaVersion !== 4 || value.artifactKind !== "exit-path-normalized-source-snapshot" || typeof value.sourceId !== "string" || typeof value.snapshotId !== "string" || new Date(value.capturedAt).toISOString() !== value.capturedAt || new Date(value.freshUntil).toISOString() !== value.freshUntil || Date.parse(value.freshUntil) <= Date.parse(value.capturedAt)) throw new Error("normalized snapshot identity mismatch");
  assertKeys(value.providerSnapshotIdentity, PROVIDER_KEYS, "provider identity keys"); for (const key of ["snapshotDigest", "rawSha256", "collectionPlanDigest", "queryPlanSha256"]) assertSha(value.providerSnapshotIdentity[key], "provider identity hash"); if (value.providerSnapshotIdentity.sourceId !== value.sourceId || value.providerSnapshotIdentity.snapshotId !== value.snapshotId || value.providerSnapshotIdentity.capturedAt !== value.capturedAt || value.providerSnapshotIdentity.freshUntil !== value.freshUntil) throw new Error("provider identity mismatch");
  assertKeys(value.coverage, ["exhaustive", "queryIds"], "normalized coverage keys"); if (value.coverage.exhaustive !== true || !Array.isArray(value.coverage.queryIds)) throw new Error("normalized coverage mismatch");
  const ids = value.queryPlan.map((query) => { assertKeys(query, QUERY_KEYS, "normalized query keys"); for (const key of QUERY_KEYS) if (typeof query[key] !== "string" || query[key] === "") throw new Error("normalized query mismatch"); return query.queryId; });
  if (new Set(ids).size !== ids.length || canonicalJson([...value.queryPlan].sort(compareQuery)) !== canonicalJson(value.queryPlan) || canonicalJson([...value.coverage.queryIds].sort(compare)) !== canonicalJson(value.coverage.queryIds) || canonicalJson([...ids].sort(compare)) !== canonicalJson(value.coverage.queryIds)) throw new Error("normalized query order mismatch");
  const results = value.results; if (!Array.isArray(results) || canonicalJson([...results].sort((left, right) => compare(left.queryId, right.queryId))) !== canonicalJson(results)) throw new Error("normalized result order mismatch");
  for (const result of results) {
    assertKeys(result, RESULT_KEYS, "normalized result keys");
    if (!ids.includes(result.queryId) || !["OBSERVED_EXIT_PATH", "EXPLICIT_ZERO", "PROVIDER_NO_DATA", "FAILED"].includes(result.state)
      || !Array.isArray(result.records) || !/^[a-f0-9]{64}$/.test(result.providerResponseSha256)) throw new Error("normalized result mismatch");
    if (result.state === "OBSERVED_EXIT_PATH" && (result.records.length === 0 || result.zeroEvidenceSha256 !== null)) throw new Error("normalized observed result mismatch");
    if (result.state === "EXPLICIT_ZERO" && (result.records.length !== 0 || result.zeroEvidenceSha256 !== result.providerResponseSha256)) throw new Error("normalized explicit zero mismatch");
    if (["PROVIDER_NO_DATA", "FAILED"].includes(result.state) && (result.records.length !== 0 || result.zeroEvidenceSha256 !== null)) throw new Error("normalized non-observation mismatch");
    for (const record of result.records) { assertKeys(record, RECORD_KEYS, "normalized record keys"); if (record.classification !== "EXIT_TO_PLATFORM_PATH" || record.providerRecordHash !== sha256(canonicalJson({ recordId: record.recordId, classification: record.classification }))) throw new Error("normalized record mismatch"); }
  }
}

function readRootRegularEntries(archive) {
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("artifact ZIP exceeds size limit");
  const footer = archive.length - 22;
  if (footer < 0 || archive.readUInt32LE(footer) !== 0x06054b50 || archive.readUInt16LE(footer + 4) !== 0 || archive.readUInt16LE(footer + 6) !== 0 || archive.readUInt16LE(footer + 8) !== 2 || archive.readUInt16LE(footer + 10) !== 2 || archive.readUInt16LE(footer + 20) !== 0) throw new Error("artifact ZIP must have exactly two entries");
  const size = archive.readUInt32LE(footer + 12); let cursor = archive.readUInt32LE(footer + 16); const end = cursor + size; const files = new Map();
  if (end !== footer || cursor < 0 || end > archive.length) throw new Error("artifact ZIP central directory bounds mismatch");
  while (cursor < end && files.size < 2) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("artifact ZIP central directory mismatch");
    const flags = archive.readUInt16LE(cursor + 8); const method = archive.readUInt16LE(cursor + 10); const crc = archive.readUInt32LE(cursor + 16); const compressed = archive.readUInt32LE(cursor + 20); const uncompressed = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28); const extraLength = archive.readUInt16LE(cursor + 30); const commentLength = archive.readUInt16LE(cursor + 32); const mode = Math.floor(archive.readUInt32LE(cursor + 38) / 65536) & 0o170000; const offset = archive.readUInt32LE(cursor + 42);
    if (compressed > MAX_ENTRY_BYTES || uncompressed > MAX_ENTRY_BYTES || cursor + 46 + nameLength + extraLength + commentLength > end) throw new Error("artifact ZIP entry bounds mismatch");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    if ((flags & 1) !== 0 || (flags & ~0x0008) !== 0 || mode !== 0o100000 || ![NORMALIZED, ADMISSION].includes(name) || files.has(name)) throw new Error("artifact ZIP root regular entry mismatch");
    if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw new Error("artifact ZIP local entry mismatch");
    const localFlags = archive.readUInt16LE(offset + 6); const localMethod = archive.readUInt16LE(offset + 8); const localNameLength = archive.readUInt16LE(offset + 26); const localExtra = archive.readUInt16LE(offset + 28); const start = offset + 30 + localNameLength + localExtra;
    if (localFlags !== flags || localMethod !== method || start + compressed > archive.length || !archive.subarray(offset + 30, offset + 30 + localNameLength).equals(Buffer.from(name))) throw new Error("artifact ZIP local entry mismatch");
    if ((flags & 8) === 0 && (archive.readUInt32LE(offset + 14) !== crc || archive.readUInt32LE(offset + 18) !== compressed || archive.readUInt32LE(offset + 22) !== uncompressed)) throw new Error("artifact ZIP local entry mismatch");
    const raw = archive.subarray(start, start + compressed); const value = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }) : (() => { throw new Error("artifact ZIP compression mismatch"); })();
    if (value.length !== uncompressed || crc32(value) !== crc) throw new Error("artifact ZIP integrity mismatch");
    if ((flags & 8) !== 0) { const descriptor = start + compressed; const signed = archive.readUInt32LE(descriptor) === 0x08074b50; const base = descriptor + (signed ? 4 : 0); if (base + 12 > archive.length || archive.readUInt32LE(base) !== crc || archive.readUInt32LE(base + 4) !== compressed || archive.readUInt32LE(base + 8) !== uncompressed) throw new Error("artifact ZIP descriptor mismatch"); }
    files.set(name, value); cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end || files.size !== 2) throw new Error("artifact ZIP entry mismatch"); return files;
}

async function publish(output, files, receipt) {
  await absent(output, "output directory"); const parent = path.dirname(output); const before = await actualDirectory(parent, "output parent"); const staging = await mkdtemp(path.join(parent, ".exit-admission-"));
  try {
    const expected = new Map([[NORMALIZED, files.get(NORMALIZED)], [ADMISSION, files.get(ADMISSION)], [RECEIPT, receipt]]);
    for (const [name, value] of expected) await writeFile(path.join(staging, name), value, { mode: 0o600 });
    const inventory = await readdir(staging); if (canonicalJson(inventory.sort(compare)) !== canonicalJson([...expected.keys()].sort(compare))) throw new Error("staging inventory mismatch");
    for (const [name, value] of expected) { const entry = await lstat(path.join(staging, name)); if (!entry.isFile() || (entry.mode & 0o777) !== 0o600 || !(await readFile(path.join(staging, name))).equals(value)) throw new Error("staging content mismatch"); }
    const after = await actualDirectory(parent, "output parent"); if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("output parent changed"); await absent(output, "output directory"); await rename(staging, output);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

function parseArgs(argv) { const names = ["artifact-archive", "repository", "admission-workflow-run-id", "provider-workflow-run-id", "head-sha", "artifact-id", "artifact-name", "artifact-archive-sha256", "output-directory"]; if (!Array.isArray(argv) || argv.length !== names.length * 2) throw new Error("artifact receipt arguments mismatch"); const values = {}; for (let i = 0; i < argv.length; i += 2) { const key = String(argv[i]).replace(/^--/, ""); if (!names.includes(key) || values[key] !== undefined || typeof argv[i + 1] !== "string" || argv[i + 1] === "") throw new Error("artifact receipt arguments mismatch"); values[key] = argv[i + 1]; } if (!path.isAbsolute(values["artifact-archive"]) || !path.isAbsolute(values["output-directory"]) || !/^[a-f0-9]{40}$/.test(values["head-sha"]) || !/^[a-f0-9]{64}$/.test(values["artifact-archive-sha256"]) || !["admission-workflow-run-id", "provider-workflow-run-id", "artifact-id"].every((key) => /^[1-9][0-9]*$/.test(values[key]) && safeId(Number(values[key])))) throw new Error("artifact receipt arguments mismatch"); return { artifactArchive: path.resolve(values["artifact-archive"]), repository: values.repository, admissionWorkflowRunId: Number(values["admission-workflow-run-id"]), providerWorkflowRunId: Number(values["provider-workflow-run-id"]), headSha: values["head-sha"], artifactId: Number(values["artifact-id"]), artifactName: values["artifact-name"], artifactArchiveSha256: values["artifact-archive-sha256"], outputDirectory: path.resolve(values["output-directory"]) }; }
async function absent(target, label) { try { await lstat(target); } catch (error) { if (error?.code === "ENOENT") return; throw error; } throw new Error(`${label} must be absent`); }
async function actualDirectory(target, label) { const entry = await lstat(target); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); return entry; }
async function unchanged(snapshot) { const current = await lstat(snapshot.target); if (current.dev !== snapshot.identity.dev || current.ino !== snapshot.identity.ino || current.size !== snapshot.identity.size || current.mtimeMs !== snapshot.identity.mtimeMs || current.mode !== snapshot.identity.mode) throw new Error("artifact archive changed"); }
function sameSnapshot(left, right) { return left.target === right.target && left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino && left.identity.size === right.identity.size && left.identity.mtimeMs === right.identity.mtimeMs && left.identity.mode === right.identity.mode; }
function parseCanonical(value, label) { let parsed; try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)); } catch { throw new Error(`${label} must be JSON`); } if (!value.equals(Buffer.from(canonicalJson(parsed)))) throw new Error(`${label} must be canonical JSON`); return parsed; }
function assertKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(compare)) !== canonicalJson([...keys].sort(compare))) throw new Error(`${label} mismatch`); }
function canonicalObject(value) { if (Array.isArray(value)) return value.map(canonicalObject); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonicalObject(value[key])])); }
function canonicalJson(value) { return JSON.stringify(canonicalObject(value)); }
function compare(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function compareQuery(left, right) { return compare(left.providerStationId, right.providerStationId) || compare(left.providerNextStationId, right.providerNextStationId) || compare(left.routeEdgeId, right.routeEdgeId) || compare(left.queryId, right.queryId); }
function sameSet(left, right) { return left.length === right.length && left.every((value) => new Set(right).has(value)); }
function bytes(value, label) { if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error(`${label} mismatch`); return Buffer.from(value); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function assertSha(value, label) { if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw new Error(`${label} mismatch`); }
function safeId(value) { return Number.isSafeInteger(value) && value > 0; }
function crc32(bytes) { let crc = 0xffffffff; for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
