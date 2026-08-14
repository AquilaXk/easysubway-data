#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { partitionMolitTransferTuples } from "./build-accessibility-source-coverage-report.mjs";
import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";
import { canonicalFacilitySourceAdmissionJson } from "./build-facility-source-admission.mjs";
import { canonicalTransferTopologyAdmissionJson } from "./build-transfer-topology-admission.mjs";
import { validateKricProviderCodeCatalogIdentity } from "./build-molit-nationwide-fixture.mjs";
import { buildMolitRailwayTransferMovementSnapshot } from "./collect-molit-railway-transfer-movement.mjs";
import { evaluateCurrentMolitTransferFreshness } from "./evaluate-current-molit-transfer-freshness.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const SOURCE_ID = "molit-railway-transfer-movement";
const SNAPSHOT_ID = "molit-railway-transfer-movement-20250811";
const ABSENCE_MODE = "EXHAUSTIVE_OFFICIAL_FILE";
const NOT_APPLICABLE_REASON = "OFFICIAL_EXHAUSTIVE_TRANSFER_TOPOLOGY_NOT_APPLICABLE";
const SOURCE_FILE = "tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz";
const METADATA_FILE = `${SOURCE_FILE}.json`;
const FACILITY_FILE = "tools/datapack/release/facility-source-admission.json";
const CANDIDATE_FILE = "tools/datapack/release/candidate-build-spec.json";
const PRODUCTION_INPUT_FILE = "tools/datapack/inputs/capital-pilot-production-source-input.json";
const SOURCE_INVENTORY_FILE = "tools/datapack/source-inventory.json";
const SOURCE_SNAPSHOTS_FILE = "tools/datapack/release/source-snapshots.json";
const PROVIDER_CATALOG_FILE = "tools/datapack/sources/kric-provider-code-catalog-20260228.json";
const FRESHNESS_POLICY_FILE = "release/product-gates/datapack-freshness-sla.json";
const SOURCE_ADMISSION_FILE = "transfer-topology-source-admission.json";
const MATRIX_FILE = "transfer-topology-admission.json";
const EXPECTED_TARGETS = ["station-sadang:seoul-4", "station-sangnoksu:seoul-4"];
const STATES = [
  "ADMITTED_NOT_APPLICABLE", "ADMITTED_TRANSFER_TOPOLOGY", "BLOCKED_WITH_EVIDENCE",
  "MISSING", "STALE", "UNKNOWN",
];
const SOURCE_ADMISSION_KEYS = [
  "schemaVersion", "artifactKind", "candidateId", "sourceId", "snapshotId",
  "sourceSnapshotSetHash", "stationSetSha256", "stationLineSetSha256", "stationLineMappingSha256",
  "rawSha256", "gzipSha256", "metadataFileSha256", "sortedContentSha256", "rowCount",
  "originalFreshUntil", "effectiveFreshUntil", "revalidationEvidenceSha256", "freshnessResultSha256",
  "observedAt", "approvedAt", "coverageScope", "licenseId", "provenanceId", "decision",
  "productionUseAllowed", "admissionDigest",
];

export function buildCurrentTransferSourceAdmission(input) {
  assertKeys(input, [
    "candidateBuildSpec", "facilityAdmission", "freshnessResult", "gzipBytes", "metadata",
    "metadataBytes", "observedAt", "policy", "productionInput", "providerCodeCatalog",
    "revalidationEvidence", "sourceInventory", "sourceSnapshots",
  ], "current TRANSFER input keys");
  const observedAtMillis = requiredUtcInstant(input.observedAt, "observedAt");
  const facility = validateFacilityAdmission(input.facilityAdmission);
  const candidate = validateCandidateContext(input.candidateBuildSpec, input.sourceSnapshots, facility.candidate);
  const sourceContext = validateSourceContext({
    gzipBytes: input.gzipBytes,
    metadata: input.metadata,
    metadataBytes: input.metadataBytes,
    sourceInventory: input.sourceInventory,
  });
  const freshness = validateFreshness({
    freshnessResult: input.freshnessResult,
    gzipBytes: input.gzipBytes,
    metadata: input.metadata,
    metadataBytes: input.metadataBytes,
    observedAtMillis,
    policy: input.policy,
    revalidationEvidence: input.revalidationEvidence,
  });
  const targets = validateTargetMappings({
    facility,
    productionInput: input.productionInput,
    providerCodeCatalog: input.providerCodeCatalog,
  });
  const projection = projectTargetTuples({ rows: sourceContext.rows, targets });
  if (projection.unmatched.length !== 0 || projection.ambiguous.length !== 0
    || projection.joined.length + projection.notApplicable.length !== targets.length) {
    throw new Error("current TRANSFER target projection mismatch");
  }
  const stationLineMappingSha256 = sha256(canonicalJson(targets));
  const coverageScope = canonicalObject({
    absenceEvidenceMode: ABSENCE_MODE,
    notApplicableTargetCount: projection.notApplicable.length,
    observedTargetCount: projection.joined.length,
    selectedRowCount: projection.summary.selectedRowCount,
    targetStationLineCount: targets.length,
  });
  const sourcePayload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "transfer-topology-source-admission",
    candidateId: candidate.candidateId,
    sourceId: SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    sourceSnapshotSetHash: candidate.sourceSetSha256,
    stationSetSha256: candidate.stationSetSha256,
    stationLineSetSha256: facility.stationLineSetSha256,
    stationLineMappingSha256,
    rawSha256: sourceContext.metadata.rawSha256,
    gzipSha256: sourceContext.metadata.gzipSha256,
    metadataFileSha256: sourceContext.metadataFileSha256,
    sortedContentSha256: sourceContext.metadata.sortedContentSha256,
    rowCount: sourceContext.metadata.rowCount,
    originalFreshUntil: sourceContext.metadata.freshUntil,
    effectiveFreshUntil: freshness.extendedFreshUntil,
    revalidationEvidenceSha256: input.revalidationEvidence.evidenceHash,
    freshnessResultSha256: freshness.resultSha256,
    observedAt: input.revalidationEvidence.observedAt,
    approvedAt: new Date(observedAtMillis).toISOString(),
    coverageScope,
    licenseId: sourceContext.licenseId,
    provenanceId: sourceContext.provenanceId,
    decision: "APPROVED",
    productionUseAllowed: true,
  });
  const sourceAdmission = canonicalObject({
    ...sourcePayload,
    admissionDigest: sha256(canonicalJson(sourcePayload)),
  });
  const topologySourceIdentity = canonicalObject({
    sourceId: SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    rawSha256: sourceContext.metadata.rawSha256,
    gzipSha256: sourceContext.metadata.gzipSha256,
    metadataFileSha256: sourceContext.metadataFileSha256,
    sortedContentSha256: sourceContext.metadata.sortedContentSha256,
    rowCount: sourceContext.metadata.rowCount,
    capturedAt: input.revalidationEvidence.observedAt,
    freshUntil: freshness.extendedFreshUntil,
    provenanceId: sourceContext.provenanceId,
    licenseId: sourceContext.licenseId,
    sourceAdmissionDigest: sourceAdmission.admissionDigest,
    revalidationEvidenceSha256: input.revalidationEvidence.evidenceHash,
    freshnessResultSha256: freshness.resultSha256,
  });
  const topologySourceIdentitySha256 = sha256(canonicalJson(topologySourceIdentity));
  const tuplePartition = canonicalObject(projection);
  const normalizedEvidenceSha256 = sha256(canonicalJson(tuplePartition));
  const cells = targets.map((target) => buildCell({
    candidate,
    facility,
    freshness,
    normalizedEvidenceSha256,
    projection,
    sourceContext,
    target,
    topologySourceIdentitySha256,
  }));
  const materializerEvidenceRows = cells.map(materializerEvidenceRow);
  const stateSummary = Object.fromEntries(STATES.map((state) => [
    state, cells.filter((cell) => cell.state === state).length,
  ]));
  const matrixPayload = canonicalObject({
    schemaVersion: 2,
    artifactKind: "transfer-topology-admission-matrix",
    candidate,
    topologySourceIdentity,
    topologySourceIdentitySha256,
    stationLineMappingSha256,
    stationLineSetSha256: facility.stationLineSetSha256,
    normalizedEvidenceSha256,
    cells,
    tuplePartition,
    materializerEvidenceRows,
    stateSummary,
    decision: "GO",
  });
  const admission = canonicalObject({
    ...matrixPayload,
    admissionDigest: sha256(canonicalJson(matrixPayload)),
  });
  canonicalCurrentTransferSourceAdmissionJson(sourceAdmission);
  canonicalTransferTopologyAdmissionJson(admission);
  return { sourceAdmission, admission };
}

export function canonicalCurrentTransferSourceAdmissionJson(result) {
  assertKeys(result, SOURCE_ADMISSION_KEYS, "current TRANSFER source admission keys");
  const { admissionDigest, ...payload } = result;
  assertSha256(admissionDigest, "current TRANSFER source admission digest");
  if (sha256(canonicalJson(payload)) !== admissionDigest) {
    throw new Error("current TRANSFER source admission digest mismatch");
  }
  return `${JSON.stringify(canonicalObject(result), null, 2)}\n`;
}

export async function main(argv, { repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)), log = console.log } = {}) {
  const args = parseArgs(argv);
  await outputMustBeAbsent(args.outputDirectory);
  const root = path.resolve(repositoryRoot);
  const [
    candidateBuildSpec, facilityAdmission, freshnessFile, gzipBytes, metadataBytes, policy,
    productionInput, providerCodeCatalog, revalidationFile, sourceInventory, sourceSnapshots,
  ] = await Promise.all([
    readJson(path.join(root, CANDIDATE_FILE)),
    readJson(path.join(root, FACILITY_FILE)),
    readRegularSnapshot(args.freshnessResult, "freshness result"),
    readFile(path.join(root, SOURCE_FILE)),
    readFile(path.join(root, METADATA_FILE)),
    readJson(path.join(root, FRESHNESS_POLICY_FILE)),
    readJson(path.join(root, PRODUCTION_INPUT_FILE)),
    readJson(path.join(root, PROVIDER_CATALOG_FILE)),
    readRegularSnapshot(args.revalidationEvidence, "revalidation evidence"),
    readJson(path.join(root, SOURCE_INVENTORY_FILE)),
    readJson(path.join(root, SOURCE_SNAPSHOTS_FILE)),
  ]);
  const result = buildCurrentTransferSourceAdmission({
    candidateBuildSpec,
    facilityAdmission,
    freshnessResult: parseJson(freshnessFile.bytes, "freshness result"),
    gzipBytes,
    metadata: parseJson(metadataBytes, "source metadata"),
    metadataBytes,
    observedAt: args.observedAt,
    policy,
    productionInput,
    providerCodeCatalog,
    revalidationEvidence: parseJson(revalidationFile.bytes, "revalidation evidence"),
    sourceInventory,
    sourceSnapshots,
  });
  await publishDirectory(args.outputDirectory, result);
  log(JSON.stringify({
    result: result.admission.decision,
    admissionDigest: result.admission.admissionDigest,
    sourceAdmissionDigest: result.sourceAdmission.admissionDigest,
    stateSummary: result.admission.stateSummary,
  }));
  return result;
}

function validateFacilityAdmission(value) {
  canonicalFacilitySourceAdmissionJson(value);
  const targetIds = Array.isArray(value.cells)
    ? value.cells.map(({ stationId, lineId }) => `${stationId}:${lineId}`).sort(compareBytes)
    : [];
  if (value.schemaVersion !== 1 || value.artifactKind !== "facility-source-admission-matrix"
    || value.decision !== "GO" || canonicalJson(targetIds) !== canonicalJson(EXPECTED_TARGETS)
    || value.cells.some(({ state }) => !String(state).startsWith("ADMITTED_FACILITY_"))) {
    throw new Error("facility admission identity mismatch");
  }
  return value;
}

function validateCandidateContext(value, sourceSnapshots, candidate) {
  if (value?.schemaVersion !== 1 || value.artifactKind !== "datapack-candidate-build-spec"
    || value.candidateId !== candidate.candidateId || !Array.isArray(value.sourceSnapshots)
    || !Array.isArray(value.sourceSnapshotIds) || !Array.isArray(sourceSnapshots)
    || value.sourceSnapshotIds.includes(SNAPSHOT_ID)) {
    throw new Error("candidate identity mismatch");
  }
  const selected = value.sourceSnapshotIds.map((snapshotId, index) => {
    const matches = sourceSnapshots.filter((entry) => entry?.snapshotId === snapshotId);
    if (matches.length !== 1) throw new Error("candidate source identity mismatch");
    const projection = value.sourceSnapshots[index];
    for (const key of [
      "snapshotId", "sourceId", "rawObjectUri", "rawSha256", "schemaFingerprint",
      "licenseStatus", "redistributionAllowed", "snapshotStatus", "credentialRedacted",
    ]) {
      if (projection?.[key] !== matches[0][key]) throw new Error("candidate source identity mismatch");
    }
    return matches[0];
  });
  if (value.sourceSnapshotIds.length !== value.sourceSnapshots.length
    || value.sourceSnapshotSetHash !== candidate.sourceSetSha256
    || sha256(JSON.stringify(selected)) !== value.sourceSnapshotSetHash) {
    throw new Error("candidate source identity mismatch");
  }
  return canonicalObject(candidate);
}

function validateSourceContext({ gzipBytes, metadata, metadataBytes, sourceInventory }) {
  const gzip = Buffer.from(gzipBytes);
  const metadataBuffer = Buffer.from(metadataBytes);
  if (sha256(gzip) !== metadata?.gzipSha256) throw new Error("source gzip identity mismatch");
  let rebuilt;
  try {
    rebuilt = buildMolitRailwayTransferMovementSnapshot({
      bytes: gunzipSync(gzip),
      capturedAt: metadata.capturedAt,
    });
  } catch (error) {
    throw new Error("source snapshot identity mismatch", { cause: error });
  }
  const { gzipBytes: ignoredBytes, gzipSha256: ignoredGzip, rows, ...rebuiltMetadata } = rebuilt;
  const { gzipSha256: ignoredTrackedGzip, ...trackedLogicalMetadata } = metadata;
  if (JSON.stringify({ ...rebuiltMetadata, gzipPath: path.basename(SOURCE_FILE) })
      !== JSON.stringify(trackedLogicalMetadata)) {
    throw new Error("source metadata identity mismatch");
  }
  const matches = sourceInventory?.sources?.filter(({ id }) => id === SOURCE_ID) ?? [];
  if (matches.length !== 1) throw new Error("source inventory identity mismatch");
  const [source] = matches;
  const admission = source.rawSnapshotAdmission;
  if (source.productionUseAllowed !== false || source.requiredForProductionPack !== false
    || source.coverageScope?.mappingStatus !== "UNMAPPED_RAW_SNAPSHOT"
    || source.capabilities?.facility?.status !== "CANDIDATE"
    || source.capabilities.facility.productionUseAllowed !== false
    || admission?.status !== "LOCKED" || admission.snapshotId !== SNAPSHOT_ID
    || admission.metadataPath !== METADATA_FILE
    || admission.metadataFileSha256 !== sha256(metadataBuffer)
    || admission.rawSha256 !== metadata.rawSha256 || admission.gzipSha256 !== metadata.gzipSha256
    || admission.rowCount !== metadata.rowCount
    || source.license?.commercialUseAllowed !== true || source.license?.derivativeWorkAllowed !== true
    || source.license?.redistributionAllowed !== true) {
    throw new Error("source inventory admission mismatch");
  }
  const provenance = canonicalObject(Object.fromEntries([
    "id", "owner", "provider", "providerDepartment", "sourceSystem", "datasetUrl", "datasetKind",
  ].map((key) => [key, source[key]])));
  return {
    metadata,
    metadataFileSha256: sha256(metadataBuffer),
    rows,
    licenseId: sha256(canonicalJson(source.license)),
    provenanceId: sha256(canonicalJson(provenance)),
  };
}

function validateFreshness({
  freshnessResult, gzipBytes, metadata, metadataBytes, observedAtMillis, policy, revalidationEvidence,
}) {
  let regenerated;
  try {
    regenerated = evaluateCurrentMolitTransferFreshness({
      evidence: revalidationEvidence,
      evaluationAt: freshnessResult?.evaluatedAt,
      gzipBytes: Buffer.from(gzipBytes),
      metadata,
      metadataBytes: Buffer.from(metadataBytes),
      now: requiredUtcInstant(freshnessResult?.evaluatedAt, "freshness evaluatedAt"),
      policy,
    });
  } catch (error) {
    throw new Error("revalidation or freshness identity mismatch", { cause: error });
  }
  if (canonicalJson(regenerated) !== canonicalJson(freshnessResult)
    || freshnessResult.observationEvidenceSha256 !== revalidationEvidence.evidenceHash
    || freshnessResult.rawEvidenceSha256 !== metadata.rawSha256
    || freshnessResult.snapshotSha256 !== metadata.gzipSha256
    || freshnessResult.currentFreshUntil !== metadata.freshUntil) {
    throw new Error("freshness result identity mismatch");
  }
  const evaluatedAt = requiredUtcInstant(freshnessResult.evaluatedAt, "freshness evaluatedAt");
  const freshUntil = requiredUtcInstant(freshnessResult.extendedFreshUntil, "freshness extendedFreshUntil");
  if (observedAtMillis < evaluatedAt || observedAtMillis >= freshUntil) {
    throw new Error("current TRANSFER admission time is outside freshness interval");
  }
  return freshnessResult;
}

function validateTargetMappings({ facility, productionInput, providerCodeCatalog }) {
  validateKricProviderCodeCatalogIdentity(providerCodeCatalog);
  if (!Array.isArray(productionInput?.kricStandardAccessibilityRoster)
    || !Array.isArray(productionInput.stationLineRows)) {
    throw new Error("current TRANSFER target mapping missing");
  }
  const cells = [...facility.cells].sort((left, right) => compareBytes(
    `${left.stationId}:${left.lineId}`, `${right.stationId}:${right.lineId}`,
  ));
  const targets = cells.map((cell) => {
    const rosterMatches = productionInput.kricStandardAccessibilityRoster.filter((entry) =>
      entry.stationId === cell.stationId && entry.lineId === cell.lineId);
    if (rosterMatches.length !== 1) throw new Error("current TRANSFER target mapping ambiguous");
    const [roster] = rosterMatches;
    const catalogMatches = providerCodeCatalog.providerLines.filter((entry) =>
      entry.railOprIsttCd === roster.railOprIsttCd && entry.lnCd === roster.lnCd);
    if (catalogMatches.length !== 1) throw new Error("current TRANSFER target mapping ambiguous");
    const stationRows = productionInput.stationLineRows.filter((entry) =>
      entry.sourceId === "molit-urban-rail-full-route"
      && entry.lineId === cell.lineId && entry.stationCode === roster.stinCd);
    if (stationRows.length !== 1 || stationRows[0].stationNameKo !== stationRows[0].normalizedName) {
      throw new Error("current TRANSFER target mapping ambiguous");
    }
    return canonicalObject({
      stationId: cell.stationId,
      stationName: stationRows[0].stationNameKo,
      stationAliases: [],
      regionId: "capital",
      lineId: cell.lineId,
      lineName: catalogMatches[0].lineName,
      operatorId: cell.operatorId,
      operatorName: catalogMatches[0].operatorName,
      providerOperatorId: roster.railOprIsttCd,
      providerLineId: roster.lnCd,
      providerStationId: roster.stinCd,
    });
  });
  if (productionInput.kricStandardAccessibilityRoster.length !== targets.length
    || canonicalJson(targets.map(({ stationId, lineId }) => `${stationId}:${lineId}`))
      !== canonicalJson(EXPECTED_TARGETS)) {
    throw new Error("current TRANSFER target mapping mismatch");
  }
  return targets;
}

function projectTargetTuples({ rows, targets }) {
  const selectedRows = [];
  const matchCounts = new Map();
  for (const target of targets) {
    const matches = rows.filter((row) => providerOperatorCode(row.RAIL_OPR_ISTT_CD) === target.providerOperatorId
      && row.LN_NM === target.lineName && row.STIN_NM === target.stationName);
    matchCounts.set(targetKey(target), matches.length);
    selectedRows.push(...matches);
  }
  const stationLines = targets.map((target) => canonicalObject({
    stationId: target.stationId,
    stationName: target.stationName,
    stationAliases: [],
    regionId: target.regionId,
    lineId: target.lineId,
    lineName: target.lineName,
    operatorId: target.operatorId,
    operatorName: target.operatorName,
  }));
  const partition = partitionMolitTransferTuples({
    artifacts: [{ artifactId: "current-transfer-targets", stationLines }],
    rows: selectedRows,
    providerCodeCatalog: { providerLines: targets.map((target) => ({
      railOprIsttCd: target.providerOperatorId,
      operatorName: target.operatorName,
      lnCd: target.providerLineId,
      lineName: target.lineName,
    })) },
  });
  const joined = partition.joined.map((entry) => canonicalObject({
    ...entry,
    providerRecordHash: providerRecordHash(selectedRows, entry),
  }));
  const mappedKeys = new Set(joined.flatMap(({ mappings }) => mappings.map(targetKey)));
  const notApplicable = targets.filter((target) => (matchCounts.get(targetKey(target)) ?? 0) === 0).map((target) =>
    canonicalObject({
      absenceEvidenceMode: ABSENCE_MODE,
      lineId: target.lineId,
      providerLineId: target.providerLineId,
      providerOperatorId: target.providerOperatorId,
      providerRecordHash: sha256(canonicalJson({
        absenceEvidenceMode: ABSENCE_MODE,
        providerLineId: target.providerLineId,
        providerOperatorId: target.providerOperatorId,
        providerStationId: target.providerStationId,
        stationId: target.stationId,
      })),
      providerStationId: target.providerStationId,
      stationId: target.stationId,
    }));
  const notApplicableKeys = new Set(notApplicable.map(targetKey));
  if (mappedKeys.size !== joined.length || notApplicableKeys.size !== notApplicable.length
    || targets.some((target) => !mappedKeys.has(targetKey(target)) && !notApplicableKeys.has(targetKey(target)))) {
    throw new Error("current TRANSFER target projection mismatch");
  }
  return canonicalObject({
    summary: {
      fullRowCount: rows.length,
      targetTupleCount: targets.length,
      observedTargetCount: joined.length,
      notApplicableTargetCount: notApplicable.length,
      selectedRowCount: selectedRows.length,
      unmatchedTargetCount: partition.unmatched.length,
      ambiguousTargetCount: partition.ambiguous.length,
    },
    joined,
    notApplicable,
    unmatched: partition.unmatched,
    ambiguous: partition.ambiguous,
  });
}

function buildCell({
  candidate, facility, freshness, normalizedEvidenceSha256, projection, sourceContext, target,
  topologySourceIdentitySha256,
}) {
  const joined = projection.joined.find(({ mappings }) => mappings.some((mapping) => targetKey(mapping) === targetKey(target)));
  const absent = projection.notApplicable.find((entry) => targetKey(entry) === targetKey(target));
  if (Boolean(joined) === Boolean(absent)) throw new Error("current TRANSFER cell projection mismatch");
  return canonicalObject({
    candidateId: candidate.candidateId,
    stationSetSha256: candidate.stationSetSha256,
    sourceSetSha256: candidate.sourceSetSha256,
    stationLineSetSha256: facility.stationLineSetSha256,
    stationLineId: `${target.stationId}:${target.lineId}`,
    stationId: target.stationId,
    lineId: target.lineId,
    operatorId: target.operatorId,
    domain: "TRANSFER",
    state: joined ? "ADMITTED_TRANSFER_TOPOLOGY" : "ADMITTED_NOT_APPLICABLE",
    topologySourceIdentitySha256,
    rawEvidenceSha256: sourceContext.metadata.rawSha256,
    normalizedEvidenceSha256,
    providerRecordHash: joined?.providerRecordHash ?? absent.providerRecordHash,
    capturedAt: freshness.observedAt,
    freshUntil: freshness.extendedFreshUntil,
    provenanceId: sourceContext.provenanceId,
    licenseId: sourceContext.licenseId,
    sourceId: SOURCE_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    mappingContractVersion: candidate.mappingContractVersion,
    materializerVersion: candidate.materializerVersion,
    applicabilityReason: joined ? "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT" : NOT_APPLICABLE_REASON,
  });
}

function materializerEvidenceRow(cell) {
  const present = cell.state === "ADMITTED_TRANSFER_TOPOLOGY";
  return canonicalObject({
    candidateId: cell.candidateId,
    stationSetSha256: cell.stationSetSha256,
    sourceSetSha256: cell.sourceSetSha256,
    stationId: cell.stationId,
    lineId: cell.lineId,
    operatorId: cell.operatorId,
    domain: "TRANSFER",
    state: present ? "VERIFIED_PRESENT" : "NOT_APPLICABLE",
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
    evidenceKind: present ? "OBSERVED" : "CURRENT_APPLICABILITY_RULE",
    evidenceReason: cell.applicabilityReason,
  });
}

async function publishDirectory(outputDirectory, result) {
  const parent = path.dirname(outputDirectory);
  const parentBefore = await lstat(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) throw new Error("output parent must be a directory");
  const staging = await mkdtemp(path.join(parent, ".current-transfer-admission-"));
  try {
    await Promise.all([
      writeFile(path.join(staging, SOURCE_ADMISSION_FILE),
        Buffer.from(canonicalCurrentTransferSourceAdmissionJson(result.sourceAdmission)), { flag: "wx", mode: 0o600 }),
      writeFile(path.join(staging, MATRIX_FILE),
        Buffer.from(`${canonicalTransferTopologyAdmissionJson(result.admission)}\n`), { flag: "wx", mode: 0o600 }),
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
  const pathFlags = new Set(["revalidation-evidence", "freshness-result", "output-directory"]);
  const allowed = new Set([...pathFlags, "observed-at"]);
  if (!Array.isArray(argv) || argv.length !== 8) throw new Error("current TRANSFER admission arguments mismatch");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = String(argv[index] ?? "").replace(/^--/u, "");
    const value = argv[index + 1];
    if (!allowed.has(flag) || values[flag] !== undefined || typeof value !== "string" || value === "") {
      throw new Error("current TRANSFER admission arguments mismatch");
    }
    if (pathFlags.has(flag) && !path.isAbsolute(value)) throw new Error(`--${flag} must be an absolute path`);
    values[flag] = pathFlags.has(flag) ? path.resolve(value) : value;
  }
  for (const flag of allowed) if (values[flag] === undefined) throw new Error("current TRANSFER admission arguments mismatch");
  requiredUtcInstant(values["observed-at"], "--observed-at");
  return {
    revalidationEvidence: values["revalidation-evidence"],
    freshnessResult: values["freshness-result"],
    outputDirectory: values["output-directory"],
    observedAt: values["observed-at"],
  };
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

async function readJson(filePath) {
  return parseJson(await readFile(filePath), path.basename(filePath));
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
}

function providerRecordHash(rows, entry) {
  const matching = rows.filter((row) => providerOperatorCode(row.RAIL_OPR_ISTT_CD) === entry.providerOperatorCode
    && row.LN_NM === entry.providerLineName && row.STIN_NM === entry.providerStationName)
    .map(canonicalObject).sort((left, right) => compareBytes(canonicalJson(left), canonicalJson(right)));
  if (matching.length !== entry.rowCount || matching.length === 0) throw new Error("provider target evidence mismatch");
  return sha256(canonicalJson(matching));
}

function providerOperatorCode(value) {
  const match = typeof value === "string" ? /^([A-Z0-9]+)\(([^()]+)\)$/u.exec(value) : null;
  if (!match) throw new Error("provider operator identity mismatch");
  return match[1];
}

function targetKey(value) {
  return `${value.stationId}\0${value.lineId}`;
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (canonicalJson(actual) !== canonicalJson(wanted)) throw new Error(`${label} mismatch`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be sha256`);
}

function canonicalObject(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalObject);
  return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
