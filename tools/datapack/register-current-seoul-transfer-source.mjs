import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rmdir, rm, unlink } from "node:fs/promises";
import path from "node:path";

import { registerSeoulTransferSourceSnapshot, TRANSFER_REGISTRATION_PATHS } from "./register-seoul-transfer-source-snapshot.mjs";
import { appendTransferCandidateSourceSnapshot, assertProjectionEqual, deriveReleaseProjection, readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import { assertExactMainPreflight, validateSeoulTransferRawReceipt } from "./publish-seoul-transfer-raw.mjs";
import { readSeoulTransferObservationDirectory } from "./collect-current-seoul-transfer-distance-duration-snapshot.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { rebuildAuthenticatedTransferTopologyMetrics } from "./build-current-transfer-topology-metrics.mjs";
import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";

const JOURNAL = "tools/datapack/.seoul-transfer-registration-transaction.json";
const LOCK = "tools/datapack/.seoul-transfer-registration.lock";
const FIXED = new Set([
  "tools/datapack/source-inventory.json",
  "release/product-gates/production-datapack-scope.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/release/candidate-build-spec.json",
]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SOURCE_ID = "seoul-metro-transfer-distance-duration";
const APPLICABILITY_PATH = TRANSFER_REGISTRATION_PATHS.applicability;
const METRICS_PATH = TRANSFER_REGISTRATION_PATHS.metrics;
const SOURCE_CANDIDATES_PATH = "tools/datapack/source-candidates.json";
const KRIC_CATALOG_PATH = "tools/datapack/sources/kric-provider-code-catalog-20260228.json";
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const canonicalBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const without = (value, key) => { const copy = { ...value }; delete copy[key]; return copy; };
const SIX_SOURCE_IDS = Object.freeze([
  "seoulmetro-cyberstation-route-map", "kric-subway-timetable", "seoul-metro-accessibility",
  "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info",
]);

function requiredRoot(value) { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("repositoryRoot is required"); return path.resolve(value); }
function target(root, relative) { if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("transaction target is invalid"); const resolved = path.resolve(root, relative); if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("transaction target escapes repository"); return resolved; }
function exactTargets(outputs, { requirePrestate = true } = {}) {
  if (!Array.isArray(outputs) || outputs.length !== 5) throw new Error("transfer registration must stage exactly five outputs");
  const names = outputs.map(({ relative }) => relative);
  const source = names.filter((name) => /^tools\/datapack\/sources\/seoul-metro-transfer-distance-duration-[0-9TZ]+\.json$/u.test(name));
  if (source.length !== 1 || new Set(names).size !== 5 || names.some((name) => !FIXED.has(name) && name !== source[0])) throw new Error("transfer registration output allowlist mismatch");
  if (outputs.some(({ bytes, prestateBytes }) => !Buffer.isBuffer(bytes) || (requirePrestate && !(prestateBytes === null || Buffer.isBuffer(prestateBytes))))) throw new Error("transaction output bytes are invalid");
}
async function safeParent(file) {
  const parent = path.dirname(file); const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("transfer registration target parent is unsafe");
  return parent;
}
async function syncParent(file) {
  const directory = await open(await safeParent(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function assertExpectedBytes(file, expected) {
  const actual = await currentBytes(file);
  if ((actual == null) !== (expected == null) || (actual != null && !actual.equals(expected))) {
    throw new Error("transfer registration preserves foreign replacement");
  }
}
async function atomicWrite(file, bytes, expected = undefined, { beforePublish = async () => {} } = {}) {
  const parent = await safeParent(file);
  if (expected !== undefined) await assertExpectedBytes(file, expected);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryCreated = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await beforePublish({ file, bytes, expected });
    if (expected !== undefined) await assertExpectedBytes(file, expected);
    if (expected === null) { await link(temporary, file); await unlink(temporary); }
    else await rename(temporary, file);
    temporaryCreated = false;
    await syncParent(file);
    await assertExpectedBytes(file, bytes);
  }
  finally { await unlink(temporary).catch(() => {}); }
}
function exactJournal(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["schemaVersion", "state", "records"].sort())
    || entry.schemaVersion !== 1 || !["PREPARED", "COMMITTED"].includes(entry.state) || !Array.isArray(entry.records) || entry.records.length !== 5) {
    throw new Error("transfer registration recovery required");
  }
  const outputNames = entry.records.map(({ relative }) => relative);
  exactTargets(outputNames.map((relative) => ({ relative, bytes: Buffer.alloc(0) })), { requirePrestate: false });
  for (const record of entry.records) {
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["relative", "beforeBase64", "beforeSha256", "nextBase64", "nextSha256"].sort())
      || (record.beforeBase64 == null) !== (record.beforeSha256 == null) || !/^[0-9a-f]{64}$/u.test(record.nextSha256 ?? "")) throw new Error("transfer registration recovery required");
    const next = Buffer.from(record.nextBase64, "base64");
    if (next.toString("base64") !== record.nextBase64 || sha(next) !== record.nextSha256) throw new Error("transfer registration recovery required");
    if (record.beforeBase64 != null) {
      const before = Buffer.from(record.beforeBase64, "base64");
      if (before.toString("base64") !== record.beforeBase64 || sha(before) !== record.beforeSha256) throw new Error("transfer registration recovery required");
    }
  }
}
async function currentBytes(file) {
  try { return (await readStableRegularFile(file, "transfer registration target")).bytes; }
  catch (error) { if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") return null; throw error; }
}
async function recover(root, { beforeRecoveryMutation = async () => {} } = {}) {
  const journal = path.join(root, JOURNAL); let entry;
  try { entry = JSON.parse(await readStableRegularFile(journal, "transfer registration journal").then(({ bytes }) => bytes)); } catch (error) { if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") return; throw new Error("transfer registration recovery required"); }
  exactJournal(entry);
  for (const record of entry.records) {
    const file = target(root, record.relative); await beforeRecoveryMutation({ state: entry.state, record, file }); const current = await currentBytes(file);
    const currentSha = current == null ? null : sha(current);
    if (entry.state === "COMMITTED") {
      if (currentSha === record.nextSha256) continue;
      if (currentSha !== record.beforeSha256) throw new Error("transfer registration recovery preserves foreign replacement");
      await atomicWrite(file, Buffer.from(record.nextBase64, "base64"), record.beforeBase64 == null ? null : Buffer.from(record.beforeBase64, "base64"));
    } else {
      if (currentSha === record.beforeSha256) continue;
      if (currentSha !== record.nextSha256) throw new Error("transfer registration recovery preserves foreign replacement");
      if (record.beforeBase64 == null) {
        const next = Buffer.from(record.nextBase64, "base64");
        await assertExpectedBytes(file, next);
        await beforeRecoveryMutation({ state: entry.state, record, file, phase: "before-remove" });
        await assertExpectedBytes(file, next);
        await rm(file, { force: false }); await syncParent(file);
      }
      else await atomicWrite(file, Buffer.from(record.beforeBase64, "base64"), Buffer.from(record.nextBase64, "base64"));
    }
  }
  await unlink(journal); await syncParent(journal);
}

async function acquireLock(root) {
  const lock = path.join(root, LOCK);
  await safeParent(lock);
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error?.code === "EEXIST") throw new Error("transfer registration lock residue exists"); throw error; }
  return async () => { await rmdir(lock); };
}

export async function commitTransferRegistrationOutputs({ repositoryRoot, outputs, failAfter = null, beforeWrite = async () => {}, beforePublish = async () => {}, beforeRecoveryMutation = async () => {}, beforeCommittedRecovery = async () => {} } = {}) {
  const root = requiredRoot(repositoryRoot); exactTargets(outputs); const release = await acquireLock(root);
  try { await recover(root, { beforeRecoveryMutation });
  const records = [];
  for (const output of outputs) {
    const file = target(root, output.relative); await safeParent(file); const before = output.prestateBytes;
    records.push({ relative: output.relative, beforeBase64: before?.toString("base64") ?? null, beforeSha256: before == null ? null : sha(before), nextBase64: output.bytes.toString("base64"), nextSha256: sha(output.bytes) });
  }
  for (const record of records) await assertExpectedBytes(target(root, record.relative), record.beforeBase64 == null ? null : Buffer.from(record.beforeBase64, "base64"));
  const journal = path.join(root, JOURNAL);
  await atomicWrite(journal, Buffer.from(JSON.stringify({ schemaVersion: 1, state: "PREPARED", records })));
  try {
    for (const [index, record] of records.entries()) {
      const bytes = Buffer.from(record.nextBase64, "base64"); const before = record.beforeBase64 == null ? null : Buffer.from(record.beforeBase64, "base64");
      await beforeWrite({ index, target: target(root, record.relative), before, next: bytes });
      await atomicWrite(target(root, record.relative), bytes, before, { beforePublish: () => beforePublish({ index, target: target(root, record.relative), before, next: bytes }) });
      if (sha(await currentBytes(target(root, record.relative))) !== record.nextSha256) throw new Error("transfer registration target verification failed");
      if (failAfter === index) throw new Error("injected commit failure");
    }
  } catch (error) { await recover(root, { beforeRecoveryMutation }); throw error; }
  await atomicWrite(journal, Buffer.from(JSON.stringify({ schemaVersion: 1, state: "COMMITTED", records })));
  await beforeCommittedRecovery({ root, records });
  await recover(root, { beforeRecoveryMutation });
  return { targets: records.map(({ relative }) => relative) };
  } finally { await release(); }
}

function parseCanonical(bytes, label) { try { return JSON.parse(bytes); } catch { throw new Error(`${label} is invalid JSON`); } }
function sourceSnapshotId(capturedAt) { return `${SOURCE_ID}-${capturedAt.replaceAll(/[-:.]/gu, "")}`; }

function validateCurrentTransferInputs({ observation, receipt, metrics, metricsBytes, applicability, applicabilityBytes, canonicalPack, canonicalPackBytes }) {
  if (!Buffer.isBuffer(canonicalPackBytes) || !Buffer.isBuffer(metricsBytes) || !Buffer.isBuffer(applicabilityBytes)
    || canonicalPack?.manifest?.channel !== "production" || canonicalPack?.manifest?.activePack?.id !== "capital"
    || !Array.isArray(canonicalPack?.packs) || canonicalPack.packs.length !== 1 || canonicalPack.packs[0]?.id !== "capital") {
    throw new Error("transfer canonical pack input mismatch");
  }
  const capital = canonicalPack.packs[0];
  const seoulLines = new Set((capital.lines ?? []).filter(({ operatorId }) => operatorId === "seoul-metro").map(({ id }) => id));
  const membership = (capital.stationLines ?? []).filter(({ lineId }) => seoulLines.has(lineId));
  if (membership.length !== 213 || new Set(membership.map(({ stationId, lineId }) => `${stationId}\0${lineId}`)).size !== 213
    || new Set(membership.map(({ stationId }) => stationId)).size !== 199
    || metrics?.artifactKind !== "current-transfer-topology-metrics"
    || metrics.artifactSha256 !== sha(canonicalJson(without(metrics, "artifactSha256")))
    || metrics.canonicalIdentity?.canonicalPackSha256 !== sha(canonicalPackBytes)
    || metrics.canonicalIdentity.stationLineCount !== 213 || metrics.canonicalIdentity.stationCount !== 199 || metrics.canonicalIdentity.physicalPairCount !== 15
    || metrics.physicalPairs?.length !== 15 || metrics.metrics?.length !== 30
    || metrics.metrics.filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE").length !== 28
    || metrics.metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL").length !== 2
    || applicability?.artifactKind !== "current-capital-transfer-topology-applicability-pre-candidate" || applicability.productionUseAllowed !== false || applicability.candidateBinding !== null
    || applicability.artifactSha256 !== sha(canonicalBytes(without(applicability, "artifactSha256")))
    || applicability.transferTopologyMetricsIdentity?.artifactSha256 !== metrics.artifactSha256
    || JSON.stringify(applicability.canonicalIdentity) !== JSON.stringify(metrics.canonicalIdentity)
    || JSON.stringify(applicability.sourceIdentity) !== JSON.stringify(metrics.sourceIdentity)
    || applicability.stateSummary?.APPLICABLE_TRANSFER_ENDPOINT !== 27 || applicability.stateSummary?.NOT_APPLICABLE_IN_CANONICAL_PAIR_SET !== 186) {
    throw new Error("transfer applicability identity mismatch");
  }
  if (metrics.sourceIdentity?.sourceId !== SOURCE_ID || metrics.sourceIdentity.endpointSha256 !== observation.manifest.endpointSha256
    || metrics.sourceIdentity.manifestSha256 !== sha(observation.manifestBytes) || metrics.sourceIdentity.observationSha256 !== sha(observation.observationBytes)
    || metrics.sourceIdentity.rawSnapshotSha256 !== sha(observation.rawBytes) || metrics.sourceIdentity.rawSha256 !== observation.manifest.rawSha256
    || metrics.sourceIdentity.contentSha256 !== observation.manifest.contentSha256 || metrics.sourceIdentity.schemaSha256 !== observation.manifest.schemaSha256
    || metrics.sourceIdentity.rowCount !== 145 || receipt.snapshotRawSha256 !== observation.manifest.rawSha256
    || receipt.snapshotId !== sourceSnapshotId(observation.manifest.capturedAt)
    || receipt.manifestSha256 !== sha(observation.manifestBytes) || receipt.observationSha256 !== sha(observation.observationBytes)) throw new Error("transfer metrics observation binding mismatch");
}

function validateTransferGovernance({ inventory, governancePolicy, governancePolicyBytes, freshnessPolicy, freshnessPolicyBytes, observation, receipt, approvedAt }) {
  if (!Buffer.isBuffer(governancePolicyBytes) || !Buffer.isBuffer(freshnessPolicyBytes)) throw new Error("transfer policy byte binding mismatch");
  validateSourceGovernancePolicy({ policy: governancePolicy, inventory, freshnessPolicy });
  const source = inventory.sources?.find(({ id }) => id === SOURCE_ID);
  const policySource = governancePolicy.sources?.find(({ sourceId }) => sourceId === SOURCE_ID);
  const sourceClass = freshnessPolicy.sourceClasses?.find(({ id }) => id === "annual_official_file");
  const review = policySource?.licenseReview;
  const approvedMillis = Date.parse(approvedAt);
  if (!source || !policySource || policySource.sourceClassId !== "annual_official_file" || policySource.retentionClassId !== "standard-90d"
    || sourceClass?.reverificationCadence !== "P1Y" || sourceClass.basisField !== "observedAt" || sourceClass.offlinePackEligible !== true || sourceClass.changePublishSla !== "P14D"
    || source.license?.commercialUseAllowed !== true || source.license?.derivativeWorkAllowed !== true || source.license?.redistributionAllowed !== true
    || review?.status !== "APPROVED" || review.termsHash !== source.admissionEvidence?.licenseEvidenceHash || review.reviewedProvider !== source.provider
    || review.reviewedDatasetUrl !== source.datasetUrl || review.approvedByRole !== policySource.approvalRole || !review.redistributionScopes?.includes("DERIVED_DATAPACK")
    || !(Date.parse(review.reviewedAt) <= approvedMillis && approvedMillis < Date.parse(review.nextReviewAt))) throw new Error("transfer governance or license is not current");
  const freshUntil = deriveFreshnessExpiresAt({ policy: freshnessPolicy, sourceClassId: "annual_official_file", basisAt: observation.manifest.capturedAt, evaluationAt: approvedAt });
  const retention = deriveRawRetentionExpiresAt({ policy: governancePolicy, sourceId: SOURCE_ID, retrievedAt: observation.manifest.capturedAt });
  const capturedMillis = Date.parse(observation.manifest.capturedAt);
  const storedMillis = Date.parse(receipt.storedAt);
  if (receipt.rawRetentionExpiresAt !== retention || !(capturedMillis <= storedMillis && storedMillis <= approvedMillis && approvedMillis < Date.parse(freshUntil) && approvedMillis < Date.parse(retention))) throw new Error("transfer retention derivation mismatch");
  return { freshUntil, retention };
}

function validatePreTransferCandidate({ candidate, ledger, inventory, inventoryInputBytes, governancePolicy, governancePolicyBytes, freshnessPolicy, approvedAt }) {
  if (!Buffer.isBuffer(inventoryInputBytes) || JSON.stringify(candidate?.sourceSnapshots?.map(({ sourceId }) => sourceId)) !== JSON.stringify(SIX_SOURCE_IDS)
    || candidate.sourceSnapshotIds?.length !== 6 || candidate.sourceSnapshots.some((projection, index) => projection.snapshotId !== candidate.sourceSnapshotIds[index])) throw new Error("transfer pre-candidate source order mismatch");
  const lineage = validateLineage(ledger);
  const selected = candidate.sourceSnapshotIds.map((snapshotId) => ledger.find((row) => row.snapshotId === snapshotId));
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  const selectedInLedgerOrder = ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  if (selected.some((row) => !row) || selected.some((row, index) => row.sourceId !== SIX_SOURCE_IDS[index] || lineage.headsBySource[row.sourceId] !== row.snapshotId)
    || selectedIds.size !== selected.length || selectedInLedgerOrder.length !== selected.length
    || candidate.sourceSnapshotSetHash !== sha(Buffer.from(JSON.stringify(selectedInLedgerOrder))) || candidate.sourceInventorySha256 !== sha(Buffer.from(JSON.stringify(inventory)))
    || candidate.networkEdgeEvidence?.sourceInventory?.path !== "tools/datapack/source-inventory.json" || candidate.networkEdgeEvidence.sourceInventory.sha256 !== sha(inventoryInputBytes)) throw new Error("transfer pre-candidate ledger or inventory binding mismatch");
  for (const [index, projection] of candidate.sourceSnapshots.entries()) {
    const ledgerRow = selected[index];
    const expected = deriveReleaseProjection({ snapshot: ledgerRow, sourceInventory: inventory, governancePolicy, governancePolicyBytes, freshnessPolicy, nowMillis: Date.parse(approvedAt) });
    try { assertProjectionEqual(projection, expected, "transfer pre-candidate projection"); }
    catch { throw new Error("transfer pre-candidate projection mismatch"); }
  }
}

export function buildTransferRegistrationOutputs({ observation, receipt, metrics, metricsBytes, applicability, applicabilityBytes, inventory, inventoryBytes: inventoryInputBytes, scope, scopeBytes, ledger, ledgerBytes: ledgerInputBytes, candidate, candidateBytes: candidateInputBytes, governancePolicy, governancePolicyBytes, freshnessPolicy, freshnessPolicyBytes, canonicalPack, canonicalPackBytes, approvedAt }) {
  validateSeoulTransferRawReceipt(receipt);
  validateCurrentTransferInputs({ observation, receipt, metrics, metricsBytes, applicability, applicabilityBytes, canonicalPack, canonicalPackBytes });
  const governance = validateTransferGovernance({ inventory, governancePolicy, governancePolicyBytes, freshnessPolicy, freshnessPolicyBytes, observation, receipt, approvedAt });
  validatePreTransferCandidate({ candidate, ledger, inventory, inventoryInputBytes, governancePolicy, governancePolicyBytes, freshnessPolicy, approvedAt });
  const snapshot = registerSeoulTransferSourceSnapshot({ observation, receipt, metrics, metricsBytes, applicability, applicabilityBytes, now: new Date(approvedAt) });
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  if (!source || source.requiredForProductionPack !== false || candidate?.sourceSnapshots?.length !== 6
    || scope?.productionSourceSet?.requiredSourceIds?.includes(SOURCE_ID)) throw new Error("transfer registration pre-operation state mismatch");
  const snapshotRelative = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  const snapshotBytes = jsonBytes(snapshot);
  const admission = {
    artifactKind: "transfer-source-admission-evidence", approvalIssue: 350, decision: "APPROVED", approvedBy: "AquilaXk", approvedAt,
    productionUseAllowed: true, snapshotId: snapshot.snapshotId, snapshotPath: snapshotRelative, snapshotFileSha256: sha(snapshotBytes),
    capturedAt: snapshot.capturedAt, observedAt: snapshot.observedAt, freshUntil: governance.freshUntil, sourceEffectiveDate: snapshot.sourceEffectiveDate,
    rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, schemaFingerprint: snapshot.schemaFingerprint,
    metricsPath: METRICS_PATH, metricsArtifactSha256: snapshot.transferTopology.metricsArtifactSha256,
    applicabilityPath: APPLICABILITY_PATH, applicabilityArtifactSha256: snapshot.transferTopology.applicabilityArtifactSha256,
    rowCount: 145, physicalPairCount: 15, directedMetricCount: 30, officialMetricCount: 28, derivedReciprocalMetricCount: 2,
    stationLineCount: 213, applicableStationLineCount: 27, notApplicableStationLineCount: 186, durationRole: "REFERENCE_ONLY",
    licenseEvidenceHash: source.admissionEvidence?.licenseEvidenceHash,
  };
  if (!/^[0-9a-f]{64}$/u.test(admission.licenseEvidenceHash ?? "")) throw new Error("transfer license evidence binding mismatch");
  const nextInventory = structuredClone(inventory); const nextSource = nextInventory.sources.find(({ id }) => id === SOURCE_ID);
  nextSource.requiredForProductionPack = true;
  nextSource.capabilities = { ...nextSource.capabilities, transfer: { status: "SUPPORTED", productionUseAllowed: true, coverageStatus: "CAPITAL_SEOUL_METRO_15_PAIRS_30_DIRECTED_METRICS", updateFrequency: "annual file snapshot", unsupportedNotes: "공식 소요시간은 reference-only이며 runtime 환승시간은 거리와 선택한 보행속도로 계산한다" } };
  nextSource.transferAdmissionEvidence = admission;
  const inventoryBytes = jsonBytes(nextInventory);
  const ledgerRow = {
    schemaVersion: 1, artifactKind: "official-source-snapshot", snapshotId: snapshot.snapshotId, sourceId: SOURCE_ID, provider: nextSource.provider,
    retrievedAt: snapshot.capturedAt, observedAt: snapshot.observedAt, sourceUpdatedAt: null, sourceEffectiveDate: "2025-12-31", rowCount: 145, coverageCount: 30,
    rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, rawObjectUri: receipt.rawObjectUri,
    redactedRequestFingerprint: snapshot.observationIdentity.sourceCandidateSha256, schemaFingerprint: snapshot.schemaFingerprint,
    snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS", redistributionAllowed: true,
    credentialRedacted: true, previousSnapshotId: null, diffSummary: null, freshnessExpiresAt: governance.freshUntil,
    rawRetentionExpiresAt: governance.retention, adminReviewRecordHash: nextSource.admissionEvidence?.adminReviewRecordHash,
    governancePolicyVersion: parseCanonical(governancePolicyBytes, "governance policy").policyVersion, governancePolicySha256: sha(governancePolicyBytes),
    rawReceipt: receipt, transferTopology: snapshot.transferTopology,
  };
  if (!/^[0-9a-f]{64}$/u.test(ledgerRow.adminReviewRecordHash ?? "")) throw new Error("transfer governance binding mismatch");
  const nextLedger = [...ledger, ledgerRow]; const ledgerBytes = jsonBytes(nextLedger);
  const projection = {
    snapshotId: ledgerRow.snapshotId, sourceId: SOURCE_ID, rawObjectUri: ledgerRow.rawObjectUri, rawSha256: ledgerRow.rawSha256,
    redactedRequestFingerprint: ledgerRow.redactedRequestFingerprint, schemaFingerprint: ledgerRow.schemaFingerprint, licenseStatus: ledgerRow.licenseStatus,
    redistributionAllowed: true, adminReviewRecordHash: ledgerRow.adminReviewRecordHash, snapshotStatus: "LOCKED", credentialRedacted: true,
    freshnessExpiresAt: ledgerRow.freshnessExpiresAt, rawRetentionExpiresAt: ledgerRow.rawRetentionExpiresAt,
    governancePolicyVersion: ledgerRow.governancePolicyVersion, governancePolicySha256: ledgerRow.governancePolicySha256,
  };
  const nextCandidate = appendTransferCandidateSourceSnapshot({ candidateBuildSpec: candidate, transferSnapshot: ledgerRow, transferProjection: projection });
  const selected = nextCandidate.sourceSnapshotIds.map((id) => nextLedger.find((row) => row.snapshotId === id));
  if (selected.some((row) => !row)) throw new Error("candidate source ledger binding mismatch");
  nextCandidate.sourceSnapshotSetHash = sha(Buffer.from(JSON.stringify(selected)));
  nextCandidate.sourceInventorySha256 = sha(Buffer.from(JSON.stringify(nextInventory)));
  nextCandidate.networkEdgeEvidence.sourceInventory.sha256 = sha(inventoryBytes);
  if (!Buffer.isBuffer(scopeBytes) || !Buffer.isBuffer(ledgerInputBytes) || !Buffer.isBuffer(candidateInputBytes)) throw new Error("transfer prestate byte binding mismatch");
  const nextScope = structuredClone(scope);
  nextScope.productionSourceSet.requiredSourceIds.push(SOURCE_ID);
  nextScope.productionSourceSet.optionalAccessibilitySourceIds = nextScope.productionSourceSet.optionalAccessibilitySourceIds.filter((id) => id !== SOURCE_ID);
  nextScope.productionSourceSet.excludedFromV1SupportClaims = nextScope.productionSourceSet.excludedFromV1SupportClaims.filter((id) => id !== SOURCE_ID);
  return [
    { relative: snapshotRelative, bytes: snapshotBytes, prestateBytes: null }, { relative: "tools/datapack/source-inventory.json", bytes: inventoryBytes, prestateBytes: inventoryInputBytes },
    { relative: "release/product-gates/production-datapack-scope.json", bytes: jsonBytes(nextScope), prestateBytes: scopeBytes },
    { relative: "tools/datapack/release/source-snapshots.json", bytes: ledgerBytes, prestateBytes: ledgerInputBytes },
    { relative: "tools/datapack/release/candidate-build-spec.json", bytes: jsonBytes(nextCandidate), prestateBytes: candidateInputBytes },
  ];
}

export async function registerCurrentSeoulTransferSource({ repositoryRoot, observationDirectory, receiptPath, approvedAt, expectedMainSha, gitRunner } = {}) {
  const root = requiredRoot(repositoryRoot); if (typeof observationDirectory !== "string" || !path.isAbsolute(observationDirectory) || typeof receiptPath !== "string" || !path.isAbsolute(receiptPath) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(approvedAt ?? "")) throw new Error("transfer registration arguments are invalid");
  await assertExactMainPreflight({ repositoryRoot: root, expectedMainSha, gitRunner });
  const readJson = async (relative, label) => {
    const entry = await readStableRegularFile(path.join(root, relative), label);
    return { bytes: entry.bytes, value: parseCanonical(entry.bytes, label) };
  };
  const readBytes = async (relative, label) => readStableRegularFile(path.join(root, relative), label);
  const receiptRead = async () => {
    const entry = await readStableRegularFile(receiptPath, "transfer OCI receipt");
    const value = validateSeoulTransferRawReceipt(parseCanonical(entry.bytes, "transfer OCI receipt"));
    return { bytes: entry.bytes, value };
  };
  const [observation, receipt, metrics, applicability, inventory, scope, ledger, candidate, governance, freshness, pack, sourceCandidates, kricCatalog] = await Promise.all([
    readSeoulTransferObservationDirectory(observationDirectory), receiptRead(), readJson(METRICS_PATH, "transfer metrics"), readJson(APPLICABILITY_PATH, "transfer applicability"), readJson("tools/datapack/source-inventory.json", "source inventory"), readJson("release/product-gates/production-datapack-scope.json", "production scope"), readJson("tools/datapack/release/source-snapshots.json", "source ledger"), readJson("tools/datapack/release/candidate-build-spec.json", "candidate"), readJson("tools/datapack/source-governance-policy.json", "governance policy"), readJson("release/product-gates/datapack-freshness-sla.json", "freshness SLA"), readJson("tools/datapack/release/capital-production-canonical-pack.json", "capital canonical pack"), readBytes(SOURCE_CANDIDATES_PATH, "source candidate contract"), readBytes(KRIC_CATALOG_PATH, "KRIC line identity"),
  ]);
  const rebuiltMetrics = rebuildAuthenticatedTransferTopologyMetrics({ canonicalPack: pack.value, canonicalPackBytes: pack.bytes, sourceCandidatesBytes: sourceCandidates.bytes, kricCatalogBytes: kricCatalog.bytes, observation: { manifest: observation.manifest, observation: observation.observation, raw: observation.rawSnapshot, bytes: { manifest: observation.manifestBytes, observation: observation.observationBytes, raw: observation.rawBytes } } });
  if (!metrics.bytes.equals(Buffer.from(`${canonicalJson(rebuiltMetrics)}\n`))) throw new Error("transfer metrics rebuild mismatch");
  const rebuiltApplicability = buildApplicability({ canonicalPack: pack.value, canonicalPackBytes: pack.bytes, transferTopologyMetrics: rebuiltMetrics, metricsBytes: metrics.bytes });
  if (!applicability.bytes.equals(Buffer.from(`${canonicalJson(rebuiltApplicability)}\n`))) throw new Error("transfer applicability rebuild mismatch");
  const outputs = buildTransferRegistrationOutputs({ observation, receipt: receipt.value, metrics: metrics.value, metricsBytes: metrics.bytes, applicability: applicability.value, applicabilityBytes: applicability.bytes, inventory: inventory.value, inventoryBytes: inventory.bytes, scope: scope.value, scopeBytes: scope.bytes, ledger: ledger.value, ledgerBytes: ledger.bytes, candidate: candidate.value, candidateBytes: candidate.bytes, governancePolicy: governance.value, governancePolicyBytes: governance.bytes, freshnessPolicy: freshness.value, freshnessPolicyBytes: freshness.bytes, canonicalPack: pack.value, canonicalPackBytes: pack.bytes, approvedAt });
  return commitTransferRegistrationOutputs({ repositoryRoot: root, outputs });
}
