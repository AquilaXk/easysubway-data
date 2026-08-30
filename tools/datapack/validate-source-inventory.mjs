#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { validateQuotaEvidence } from "./lib/quota-evidence.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import { officialOdFareAdmissionsBySource } from "./lib/official-od-fare-evidence.mjs";
import { validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import {
  buildMolitRailwayTransferMovementSnapshot,
  MOLIT_RAILWAY_TRANSFER_MOVEMENT_RAW_SHA256,
  MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID,
} from "./collect-molit-railway-transfer-movement.mjs";

const args = process.argv.slice(2);
const inventoryPath = optionValue("--inventory") ?? "tools/datapack/source-inventory.json";
const candidatesPath = optionValue("--candidates") ?? "tools/datapack/source-candidates.json";
const officialOdFareAdmissionPath = optionValue("--official-od-fare-admission")
  ?? "tools/datapack/official-od-fare-admission.json";
const scopePath = optionValue("--scope");
const governancePolicyPath = optionValue("--governance-policy");
const freshnessPolicyPath = optionValue("--freshness-policy");
const compareStrings = (left, right) => codepointCompare(left, right);
const officialOdFareFields = new Set([
  "childCardFare",
  "childCashFare",
  "gnrlCardFare",
  "gnrlCashFare",
  "yungCardFare",
  "yungCashFare",
]);

export async function main() {
  try {
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
  const scope = scopePath ? JSON.parse(await readFile(scopePath, "utf8")) : null;
  validateInventory(inventory);
  await validateProductionTransferArtifacts(inventory);
  if ((governancePolicyPath == null) !== (freshnessPolicyPath == null)) {
    throw new Error("--governance-policy and --freshness-policy must be provided together");
  }
  if (governancePolicyPath) {
    const [policy, freshnessPolicy] = await Promise.all([
      readFile(governancePolicyPath, "utf8").then(JSON.parse),
      readFile(freshnessPolicyPath, "utf8").then(JSON.parse),
    ]);
    validateSourceGovernancePolicy({ policy, inventory, freshnessPolicy });
  }
  const officialOdFareAdmissionBytes = inventory.sources.some(
    (source) => source.officialOdFareAdmissionHash != null || source.fareStationLineMappingLedgerHash != null,
  ) ? await readFile(officialOdFareAdmissionPath) : null;
  await validateAdmittedCandidateEvidence(inventory, candidates, officialOdFareAdmissionBytes);
  if (scope) {
    validateProductionScope(inventory, scope);
  }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function validateInventory(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("source inventory must be an object");
  }
  assertEqual(inventory.schemaVersion, 1, "schemaVersion");
  assertString(inventory.region, "region");
  assertEqual(inventory.artifactKind, "production-source-inventory", "artifactKind");
  assertDate(inventory.retrievedAt, "retrievedAt");
  if (!Array.isArray(inventory.sources) || inventory.sources.length === 0) {
    throw new Error("sources must be a non-empty array");
  }

  const ids = new Set();
  for (const [index, source] of inventory.sources.entries()) {
    validateSource(source, `sources[${index}]`);
    if (ids.has(source.id)) {
      throw new Error(`duplicate source id: ${source.id}`);
    }
    ids.add(source.id);
  }
  validateSharedQuotaStores(inventory.sources);
}

function validateSharedQuotaStores(sources) {
  const limitsByStore = new Map();
  for (const source of sources) {
    const quota = source.admissionEvidence?.quotaEvidence;
    if (!quota?.sharedQuotaStore) continue;
    const limits = `${quota.runtimeDailyHardLimit}:${quota.runtimePerMinuteHardLimit}`;
    const existing = limitsByStore.get(quota.sharedQuotaStore);
    if (existing !== undefined && existing !== limits) {
      throw new Error(`shared quota store ${quota.sharedQuotaStore} must use identical runtime hard limits`);
    }
    limitsByStore.set(quota.sharedQuotaStore, limits);
  }
}

function validateSource(source, label) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${label} must be an object`);
  }

  const id = assertString(source.id, `${label}.id`);
  assertString(source.displayName, `${id}.displayName`);
  assertString(source.owner, `${id}.owner`);
  assertString(source.provider, `${id}.provider`);
  assertString(source.sourceSystem, `${id}.sourceSystem`);
  assertHttpsUrl(source.datasetUrl, `${id}.datasetUrl`);
  assertString(source.updateFrequency, `${id}.updateFrequency`);
  assertDate(source.retrievedAt, `${id}.retrievedAt`);

  if (typeof source.requiredForProductionPack !== "boolean") {
    throw new TypeError(`${id}.requiredForProductionPack must be boolean`);
  }
  assertDate(source.observedDataUpdatedAt, `${id}.observedDataUpdatedAt`);
  validateLicense(source.license, id);
  validateCoverageScope(source.coverageScope, source, id);
  validateCapabilities(source.capabilities, source, id);
  if (id === "seoul-metro-transfer-distance-duration" && source.requiredForProductionPack === true) {
    validateTransferAdmissionEvidence(source);
  }

  if (!Array.isArray(source.fieldsProvided) || source.fieldsProvided.length === 0) {
    throw new Error(`${id}.fieldsProvided must be a non-empty array`);
  }
  for (const field of source.fieldsProvided) {
    assertString(field, `${id}.fieldsProvided[]`);
  }
  validateOfficialOdFareReferences(source, id);
}

export function validateTransferAdmissionEvidence(source) {
  const evidence = source.transferAdmissionEvidence;
  const exact = ["artifactKind", "approvalIssue", "decision", "approvedBy", "approvedAt", "productionUseAllowed", "snapshotId", "snapshotPath", "snapshotFileSha256", "capturedAt", "observedAt", "freshUntil", "sourceEffectiveDate", "rawSha256", "contentSha256", "schemaFingerprint", "metricsPath", "metricsArtifactSha256", "applicabilityPath", "applicabilityArtifactSha256", "rowCount", "physicalPairCount", "directedMetricCount", "officialMetricCount", "derivedReciprocalMetricCount", "stationLineCount", "applicableStationLineCount", "notApplicableStationLineCount", "durationRole", "licenseEvidenceHash"];
  if (!evidence || Object.keys(evidence).length !== exact.length || exact.some((key) => !(key in evidence))
    || evidence.artifactKind !== "transfer-source-admission-evidence" || evidence.approvalIssue !== 350 || evidence.decision !== "APPROVED" || evidence.approvedBy !== "AquilaXk" || evidence.productionUseAllowed !== true
    || evidence.sourceEffectiveDate !== "2025-12-31" || evidence.observedAt !== evidence.capturedAt || evidence.rowCount !== 145 || evidence.physicalPairCount !== 15 || evidence.directedMetricCount !== 30 || evidence.officialMetricCount !== 28 || evidence.derivedReciprocalMetricCount !== 2 || evidence.stationLineCount !== 213 || evidence.applicableStationLineCount !== 27 || evidence.notApplicableStationLineCount !== 186 || evidence.durationRole !== "REFERENCE_ONLY"
    || evidence.metricsPath !== "tools/datapack/release/current-transfer-topology-metrics.json" || evidence.applicabilityPath !== "tools/datapack/release/current-capital-transfer-topology-applicability.json" || evidence.licenseEvidenceHash !== source.admissionEvidence?.licenseEvidenceHash) {
    throw new Error("transfer admission evidence contract mismatch");
  }
  for (const key of ["snapshotFileSha256", "rawSha256", "contentSha256", "schemaFingerprint", "metricsArtifactSha256", "applicabilityArtifactSha256", "licenseEvidenceHash"]) assertSha256(evidence[key], `transfer.${key}`);
  if (typeof evidence.snapshotId !== "string" || evidence.snapshotId.trim() === "" || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`) throw new Error("transfer admission evidence snapshot identity mismatch");
  const capturedAt = canonicalUtcInstant(evidence.capturedAt, "transfer.capturedAt");
  const observedAt = canonicalUtcInstant(evidence.observedAt, "transfer.observedAt");
  const approvedAt = canonicalUtcInstant(evidence.approvedAt, "transfer.approvedAt");
  const freshUntil = canonicalUtcInstant(evidence.freshUntil, "transfer.freshUntil");
  if (capturedAt !== observedAt || observedAt > approvedAt || approvedAt >= freshUntil) throw new Error("transfer admission evidence time ordering mismatch");
}

function canonicalUtcInstant(value, label) {
  const millis = requiredUtcInstant(value, label);
  if (new Date(millis).toISOString() !== value) throw new Error(`${label} must be canonical UTC`);
  return millis;
}

export async function validateProductionTransferArtifacts(inventory, { repositoryRoot = process.cwd() } = {}) {
  const source = inventory?.sources?.find(({ id }) => id === "seoul-metro-transfer-distance-duration");
  if (!source || source.requiredForProductionPack !== true) return;
  const evidence = source.transferAdmissionEvidence;
  const stableJson = async (relative, label) => {
    const entry = await readStableRegularFile(path.resolve(repositoryRoot, relative), label);
    try { return { bytes: entry.bytes, value: JSON.parse(entry.bytes) }; } catch { throw new Error(`${label} is invalid JSON`); }
  };
  const [snapshot, metrics, applicability] = await Promise.all([
    stableJson(evidence.snapshotPath, "transfer snapshot artifact"),
    stableJson("tools/datapack/release/current-transfer-topology-metrics.json", "transfer metrics artifact"),
    stableJson("tools/datapack/release/current-capital-transfer-topology-applicability.json", "transfer applicability artifact"),
  ]);
  const snapshotSelf = sha256(Buffer.from(`${canonicalJson(Object.fromEntries(Object.entries(snapshot.value).filter(([key]) => key !== "snapshotSha256")))}\n`));
  if (sha256(snapshot.bytes) !== evidence.snapshotFileSha256 || snapshot.value.snapshotSha256 !== snapshotSelf || snapshot.value.snapshotId !== evidence.snapshotId || snapshot.value.sourceId !== source.id
    || snapshot.value.rawSha256 !== evidence.rawSha256 || snapshot.value.contentSha256 !== evidence.contentSha256 || snapshot.value.schemaFingerprint !== evidence.schemaFingerprint) throw new Error("transfer snapshot artifact identity mismatch");
  const metricsSelf = sha256(Buffer.from(canonicalJson(Object.fromEntries(Object.entries(metrics.value).filter(([key]) => key !== "artifactSha256")))));
  if (!metrics.bytes.equals(Buffer.from(`${canonicalJson(metrics.value)}\n`)) || metrics.value.artifactSha256 !== evidence.metricsArtifactSha256 || metricsSelf !== evidence.metricsArtifactSha256
    || metrics.value.sourceIdentity?.sourceId !== source.id || metrics.value.sourceIdentity?.rawSha256 !== evidence.rawSha256
    || metrics.value.sourceIdentity?.contentSha256 !== evidence.contentSha256 || metrics.value.sourceIdentity?.schemaSha256 !== evidence.schemaFingerprint) throw new Error("transfer metrics artifact identity mismatch");
  const applicabilitySelf = sha256(Buffer.from(`${canonicalJson(Object.fromEntries(Object.entries(applicability.value).filter(([key]) => key !== "artifactSha256")))}\n`));
  if (!applicability.bytes.equals(Buffer.from(`${canonicalJson(applicability.value)}\n`)) || applicability.value.artifactSha256 !== evidence.applicabilityArtifactSha256 || applicabilitySelf !== evidence.applicabilityArtifactSha256
    || JSON.stringify(applicability.value.canonicalIdentity) !== JSON.stringify(metrics.value.canonicalIdentity)
    || JSON.stringify(applicability.value.sourceIdentity) !== JSON.stringify(metrics.value.sourceIdentity)
    || applicability.value.transferTopologyMetricsIdentity?.artifactSha256 !== evidence.metricsArtifactSha256) throw new Error("transfer applicability artifact identity mismatch");
}

function validateOfficialOdFareReferences(source, sourceId) {
  const declaredFareFields = new Set(source.fieldsProvided.filter((field) => officialOdFareFields.has(field)));
  const declaresReference = source.officialOdFareAdmissionHash != null
    || source.fareStationLineMappingLedgerHash != null;
  if (declaredFareFields.size === 0 && !declaresReference) return;
  if (declaredFareFields.size !== officialOdFareFields.size) {
    throw new Error(`${sourceId} official OD fare references require all six official fare fields`);
  }
  assertSha256(source.officialOdFareAdmissionHash, `${sourceId}.officialOdFareAdmissionHash`);
  assertSha256(source.fareStationLineMappingLedgerHash, `${sourceId}.fareStationLineMappingLedgerHash`);
}

export function validateCapabilities(capabilities, source, sourceId) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error(`${sourceId}.capabilities must be an object`);
  }

  const capabilityNames = ["schedule", "realtime", "facility"];
  const transferSource = sourceId === "seoul-metro-transfer-distance-duration" && source.requiredForProductionPack === true;
  if (transferSource) capabilityNames.push("transfer");
  for (const name of capabilityNames) {
    validateCapability(capabilities[name], source, sourceId, name);
  }

  const declaredCapabilityNames = Object.keys(capabilities).sort(compareStrings);
  const expectedCapabilityNames = [...capabilityNames].sort(compareStrings);
  if (JSON.stringify(declaredCapabilityNames) !== JSON.stringify(expectedCapabilityNames)) {
    throw new Error(`${sourceId}.capabilities must declare its exact closed capability set`);
  }
}

function validateCapability(capability, source, sourceId, name) {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    throw new Error(`${sourceId}.capabilities.${name} must be an object`);
  }

  const status = assertString(capability.status, `${sourceId}.capabilities.${name}.status`);
  if (!["SUPPORTED", "CANDIDATE", "UNSUPPORTED"].includes(status)) {
    throw new Error(`${sourceId}.capabilities.${name}.status must be SUPPORTED, CANDIDATE, or UNSUPPORTED`);
  }
  if (typeof capability.productionUseAllowed !== "boolean") {
    throw new TypeError(`${sourceId}.capabilities.${name}.productionUseAllowed must be boolean`);
  }
  assertString(capability.coverageStatus, `${sourceId}.capabilities.${name}.coverageStatus`);
  assertString(capability.updateFrequency, `${sourceId}.capabilities.${name}.updateFrequency`);
  assertString(capability.unsupportedNotes, `${sourceId}.capabilities.${name}.unsupportedNotes`);

  if (status === "UNSUPPORTED" && capability.productionUseAllowed !== false) {
    throw new Error(`${sourceId}.capabilities.${name}.productionUseAllowed must be false when unsupported`);
  }
  if (status !== "SUPPORTED" && capability.productionUseAllowed !== false) {
    throw new Error(`${sourceId}.capabilities.${name}.productionUseAllowed requires SUPPORTED status`);
  }
  if (
    capability.productionUseAllowed &&
    (source.license.commercialUseAllowed !== true || source.license.redistributionAllowed !== true)
  ) {
    throw new Error(`${sourceId}.capabilities.${name}.productionUseAllowed requires commercial use and redistribution license`);
  }

  if (name !== "realtime") {
    if (name === "transfer" && (capability.status !== "SUPPORTED"
      || capability.productionUseAllowed !== true
      || capability.coverageStatus !== "CAPITAL_SEOUL_METRO_15_PAIRS_30_DIRECTED_METRICS"
      || capability.updateFrequency !== "annual file snapshot"
      || capability.unsupportedNotes !== "공식 소요시간은 reference-only이며 runtime 환승시간은 거리와 선택한 보행속도로 계산한다")) {
      throw new Error(`${sourceId}.capabilities.transfer contract mismatch`);
    }
    return;
  }
  if (typeof capability.liveEtaEligible !== "boolean") {
    throw new TypeError(`${sourceId}.capabilities.realtime.liveEtaEligible must be boolean`);
  }
  const rateLimitStatus = assertString(capability.rateLimitStatus, `${sourceId}.capabilities.realtime.rateLimitStatus`);
  const compatibleRateLimitStatuses = new Set(["COMPATIBLE", "GUARDED_DEFAULT_DAILY_LIMIT"]);
  if (
    capability.liveEtaEligible &&
    (capability.productionUseAllowed !== true || !compatibleRateLimitStatuses.has(rateLimitStatus))
  ) {
    throw new Error(`${sourceId}.capabilities.realtime live ETA requires compatible provider terms and rate limits`);
  }
  if (capability.liveEtaEligible && rateLimitStatus === "GUARDED_DEFAULT_DAILY_LIMIT") {
    validateGuardedRealtimeQuota(source, sourceId);
  }
}

function validateGuardedRealtimeQuota(source, sourceId) {
  const quotaEvidence = source.admissionEvidence?.quotaEvidence;
  validateQuotaEvidence(quotaEvidence, `${sourceId}.admissionEvidence.quotaEvidence`);
  if (!Number.isInteger(quotaEvidence.runtimeDailyHardLimit) || !Number.isInteger(quotaEvidence.runtimePerMinuteHardLimit)) {
    throw new TypeError(`${sourceId}.guarded realtime requires integer runtime daily and per-minute hard limits`);
  }
  if (typeof quotaEvidence.sharedQuotaStore !== "string" || quotaEvidence.sharedQuotaStore.trim() === "") {
    throw new TypeError(`${sourceId}.guarded realtime requires sharedQuotaStore`);
  }
}

function validateProductionScope(inventory, scope) {
  const sourceSet = scope?.productionSourceSet;
  if (!sourceSet || typeof sourceSet !== "object" || Array.isArray(sourceSet)) {
    throw new Error("productionSourceSet must be an object");
  }
  const requiredSourceIds = new Set(assertStringArray(sourceSet.requiredSourceIds, "productionSourceSet.requiredSourceIds"));
  const optionalSourceIds = new Set(
    assertStringArray(sourceSet.optionalAccessibilitySourceIds, "productionSourceSet.optionalAccessibilitySourceIds"),
  );
  const excludedSourceIds = new Set(
    assertStringArray(sourceSet.excludedFromV1SupportClaims, "productionSourceSet.excludedFromV1SupportClaims"),
  );
  const sources = new Map(inventory.sources.map((source) => [source.id, source]));

  assertDisjoint(requiredSourceIds, optionalSourceIds, "requiredSourceIds", "optionalAccessibilitySourceIds");
  assertDisjoint(requiredSourceIds, excludedSourceIds, "requiredSourceIds", "excludedFromV1SupportClaims");
  assertDisjoint(optionalSourceIds, excludedSourceIds, "optionalAccessibilitySourceIds", "excludedFromV1SupportClaims");

  for (const sourceId of requiredSourceIds) {
    const source = requireInventorySource(sources, sourceId);
    if (source.requiredForProductionPack !== true) {
      throw new Error(`required source ${sourceId} must be requiredForProductionPack`);
    }
  }
  for (const sourceId of optionalSourceIds) {
    const source = requireInventorySource(sources, sourceId);
    if (source.requiredForProductionPack !== false) {
      throw new Error(`optional source ${sourceId} must not be requiredForProductionPack`);
    }
  }
  for (const sourceId of excludedSourceIds) {
    const source = requireInventorySource(sources, sourceId);
    if (source.requiredForProductionPack !== false) {
      throw new Error(`excluded source ${sourceId} must not be requiredForProductionPack`);
    }
  }

  for (const source of inventory.sources) {
    if (source.requiredForProductionPack === true && !requiredSourceIds.has(source.id)) {
      throw new Error(`${source.id}.requiredForProductionPack must match productionSourceSet.requiredSourceIds`);
    }
  }
}

async function validateAdmittedCandidateEvidence(inventory, candidates, officialOdFareAdmissionBytes) {
  if (!candidates || typeof candidates !== "object" || Array.isArray(candidates)) {
    throw new Error("source candidates must be an object");
  }
  assertEqual(candidates.schemaVersion, 1, "source candidates schemaVersion");
  assertEqual(candidates.artifactKind, "production-source-candidates", "source candidates artifactKind");
  if (!Array.isArray(candidates.candidates)) {
    throw new Error("source candidates must include candidates array");
  }

  const sources = new Map(inventory.sources.map((source) => [source.id, source]));
  const unmatchedFareSourceIds = new Set(inventory.sources
    .filter((source) => source.officialOdFareAdmissionHash != null || source.fareStationLineMappingLedgerHash != null)
    .map((source) => source.id));
  const unmatchedSnapshotSourceIds = new Set(inventory.sources
    .filter((source) => source.rawSnapshotAdmission != null)
    .map((source) => source.id));
  for (const candidate of candidates.candidates) {
    if (candidate?.rawSnapshotAdmission != null && candidate.admissionStatus !== "official_snapshot_admitted") {
      throw new Error(`${candidate.id} official snapshot admissionStatus invalid`);
    }
    if (candidate?.admissionStatus === "official_snapshot_admitted") {
      const source = sources.get(candidate.id);
      if (!source) throw new Error(`${candidate.id} official snapshot missing inventory source`);
      if (!unmatchedSnapshotSourceIds.delete(candidate.id)) {
        throw new Error(`${candidate.id} official snapshot requires exactly one inventory binding`);
      }
      if (source.requiredForProductionPack || source.capabilities.facility.productionUseAllowed
        || source.capabilities.schedule.productionUseAllowed || source.capabilities.realtime.productionUseAllowed) {
        throw new Error(`${candidate.id} official snapshot must remain non-production`);
      }
      const candidateBinding = candidate.rawSnapshotAdmission;
      const inventoryBinding = source.rawSnapshotAdmission;
      if (!candidateBinding || !inventoryBinding || JSON.stringify(candidateBinding) !== JSON.stringify(inventoryBinding)) {
        throw new Error(`${candidate.id} official snapshot binding mismatch`);
      }
      for (const field of ["snapshotId", "metadataPath", "metadataFileSha256", "rawSha256", "gzipSha256", "rowCount", "status"]) {
        if (candidateBinding[field] == null) throw new Error(`${candidate.id} official snapshot ${field} missing`);
      }
      if (!/^[0-9a-f]{64}$/.test(candidateBinding.metadataFileSha256)
        || !/^[0-9a-f]{64}$/.test(candidateBinding.rawSha256)
        || !/^[0-9a-f]{64}$/.test(candidateBinding.gzipSha256)
        || candidateBinding.rowCount !== 8054 || candidateBinding.status !== "LOCKED") {
        throw new Error(`${candidate.id} official snapshot binding invalid`);
      }
      if (candidate.id !== MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID
        || candidateBinding.rawSha256 !== MOLIT_RAILWAY_TRANSFER_MOVEMENT_RAW_SHA256) {
        throw new Error(`${candidate.id} official snapshot raw hash is not the pinned provider artifact`);
      }
      const metadataBytes = await readFile(candidateBinding.metadataPath);
      if (sha256(metadataBytes) !== candidateBinding.metadataFileSha256) {
        throw new Error(`${candidate.id} official snapshot metadata hash mismatch`);
      }
      const metadata = JSON.parse(metadataBytes);
      for (const field of ["snapshotId", "rawSha256", "gzipSha256", "rowCount"]) {
        if (metadata[field] !== candidateBinding[field]) throw new Error(`${candidate.id} official snapshot metadata ${field} mismatch`);
      }
      if (metadata.sourceId !== candidate.id || metadata.artifactKind !== "molit-railway-transfer-movement-snapshot-metadata") {
        throw new Error(`${candidate.id} official snapshot metadata identity mismatch`);
      }
      requiredUtcInstant(metadata.capturedAt, `${candidate.id} official snapshot capturedAt`);
      if (metadata.gzipPath !== `${candidateBinding.snapshotId}.csv.gz`) {
        throw new Error(`${candidate.id} official snapshot metadata mismatch`);
      }
      const gzipBytes = await readFile(path.resolve(path.dirname(candidateBinding.metadataPath), metadata.gzipPath));
      if (sha256(gzipBytes) !== candidateBinding.gzipSha256) throw new Error(`${candidate.id} official snapshot gzip hash mismatch`);
      const rawBytes = gunzipSync(gzipBytes);
      if (sha256(rawBytes) !== candidateBinding.rawSha256) {
        throw new Error(`${candidate.id} official snapshot raw hash mismatch`);
      }
      const rebuilt = buildMolitRailwayTransferMovementSnapshot({ bytes: rawBytes, capturedAt: metadata.capturedAt });
      const { gzipBytes: ignoredGzipBytes, gzipSha256: ignoredRebuiltGzipSha256, rows: ignoredRows, ...rebuiltMetadata } = rebuilt;
      const { gzipSha256: ignoredMetadataGzipSha256, ...logicalMetadata } = metadata;
      if (JSON.stringify({ ...rebuiltMetadata, gzipPath: metadata.gzipPath }) !== JSON.stringify(logicalMetadata)) {
        throw new Error(`${candidate.id} official snapshot metadata mismatch`);
      }
      continue;
    }
    if (candidate?.admissionStatus === "official_od_fare_admitted_to_production_inventory") {
      validateOfficialOdFareCandidate(candidate, sources, officialOdFareAdmissionBytes);
      const sourceId = candidate.productionInventoryReferenceId ?? candidate.id;
      if (!unmatchedFareSourceIds.delete(sourceId)) {
        throw new Error(`${sourceId} official OD fare source must have exactly one admitted candidate`);
      }
      continue;
    }
    if (candidate?.admissionStatus !== "admitted_to_production_inventory") {
      continue;
    }
    const sourceId = assertString(
      candidate.productionInventoryReferenceId ?? candidate.id,
      `${candidate.id}.productionInventoryReferenceId`,
    );
    const source = sources.get(sourceId);
    if (!source) {
      throw new Error(`${candidate.id} admitted candidate missing production inventory source: ${sourceId}`);
    }
    validateAdmissionEvidence(source.admissionEvidence, candidate, source, sourceId);
  }
  if (unmatchedFareSourceIds.size !== 0) {
    throw new Error(`${[...unmatchedFareSourceIds][0]} official OD fare source requires an admitted candidate`);
  }
  if (unmatchedSnapshotSourceIds.size !== 0) {
    throw new Error(`${[...unmatchedSnapshotSourceIds][0]} official snapshot requires an admitted candidate`);
  }
}

function validateOfficialOdFareCandidate(candidate, sources, admissionBytes) {
  const sourceId = assertString(
    candidate.productionInventoryReferenceId ?? candidate.id,
    `${candidate.id}.productionInventoryReferenceId`,
  );
  const source = sources.get(sourceId);
  if (!source) {
    throw new Error(`${candidate.id} admitted candidate missing production inventory source: ${sourceId}`);
  }
  assertEqual(candidate.domain, "official_od_fares", `${candidate.id}.candidate domain`);
  if (JSON.stringify(source.coverageScope.sourceDomains) !== JSON.stringify(["official_od_fares"])) {
    throw new Error(`${sourceId}.source domain must be official_od_fares`);
  }
  const evidenceHash = assertSha256(
    candidate.evidence?.liveSampleEvidenceHash,
    `${candidate.id}.evidence.liveSampleEvidenceHash`,
  );
  const snapshotId = assertString(candidate.evidence?.snapshotId, `${candidate.id}.evidence.snapshotId`);
  for (const field of ["officialOdFareAdmissionHash", "fareStationLineMappingLedgerHash"]) {
    assertSha256(candidate.evidence?.[field], `${candidate.id}.evidence.${field}`);
    assertEqual(candidate.evidence[field], source[field], `${candidate.id}.evidence.${field} must match production inventory`);
  }
  if (!admissionBytes) throw new Error("official OD fare admission artifact is required");
  const admission = officialOdFareAdmissionsBySource(JSON.parse(admissionBytes)).get(sourceId);
  if (!admission) throw new Error(`${sourceId} official OD fare admission is missing`);
  assertEqual(admission.sourceId, sourceId, "admission sourceId");
  assertEqual(admission.snapshotId, snapshotId, "admission snapshotId");
  assertEqual(admission.evidenceHash, evidenceHash, "admission evidenceHash");
  if (!Number.isSafeInteger(admission.quoteCount) || admission.quoteCount < 1) {
    throw new Error("admission quoteCount must be a positive safe integer");
  }
  assertSha256(admission.quoteSetHash, "admission quoteSetHash");
  assertString(admission.approvedBy, "admission approvedBy");
  assertString(admission.approvedAt, "admission approvedAt");
  assertEqual(
    admission.fareStationLineMappingLedgerHash,
    source.fareStationLineMappingLedgerHash,
    "admission fareStationLineMappingLedgerHash",
  );
  assertEqual(
    sha256(admissionBytes),
    source.officialOdFareAdmissionHash,
    "admission artifact hash",
  );
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort(compareStrings)) !== JSON.stringify([...expectedKeys].sort(compareStrings))) {
    throw new Error(`${label} must contain only approved fields`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateAdmissionEvidence(evidence, candidate, source, sourceId) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error(`${sourceId}.admissionEvidence must be an object for admitted candidate ${candidate.id}`);
  }
  assertEqual(evidence.artifactKind, "source-admission-pipeline-evidence-summary", `${sourceId}.admissionEvidence.artifactKind`);
  assertEqual(evidence.candidateId, candidate.id, `${sourceId}.admissionEvidence.candidateId`);
  assertEqual(evidence.sourceId, sourceId, `${sourceId}.admissionEvidence.sourceId`);
  assertString(evidence.snapshotId, `${sourceId}.admissionEvidence.snapshotId`);
  assertEqual(evidence.decision, "APPROVED", `${sourceId}.admissionEvidence.decision`);
  assertString(evidence.approvedBy, `${sourceId}.admissionEvidence.approvedBy`);
  assertString(evidence.approvedAt, `${sourceId}.admissionEvidence.approvedAt`);

  for (const field of [
    "sampleEvidenceHash",
    "rawSha256",
    "schemaFingerprint",
    "sourceSnapshotSetHash",
    "sourceInventorySha256",
    "adminReviewRecordHash",
    "licenseEvidenceHash",
    "aliasLedgerHash",
    "operatorMappingLedgerHash",
    "facilityEvidenceLedgerHash",
    "routeEvidenceLedgerHash",
    "overrideHash",
  ]) {
    assertSha256(evidence[field], `${sourceId}.admissionEvidence.${field}`);
  }

  const liveSampleEvidenceHash = assertString(
    candidate.evidence?.liveSampleEvidenceHash,
    `${candidate.id}.evidence.liveSampleEvidenceHash`,
  );
  assertEqual(
    evidence.sampleEvidenceHash,
    liveSampleEvidenceHash,
    `${sourceId}.admissionEvidence.sampleEvidenceHash`,
  );
  if (!Number.isInteger(evidence.admissionDurationSeconds) || evidence.admissionDurationSeconds < 0) {
    throw new Error(`${sourceId}.admissionEvidence.admissionDurationSeconds must be a non-negative integer`);
  }
  validateQuotaEvidence(evidence.quotaEvidence, `${sourceId}.admissionEvidence.quotaEvidence`);
  if (sourceHasProductionCapability(source) && evidence.quotaEvidence.productionUseAllowed !== true) {
    throw new Error(
      `${sourceId}.admissionEvidence.quotaEvidence.productionUseAllowed must be true when source has production capability`,
    );
  }
}

function sourceHasProductionCapability(source) {
  return ["schedule", "realtime", "facility"].some(
    (capabilityName) => source.capabilities?.[capabilityName]?.productionUseAllowed === true,
  );
}

function requireInventorySource(sources, sourceId) {
  const source = sources.get(sourceId);
  if (!source) {
    throw new Error(`source inventory missing: ${sourceId}`);
  }
  return source;
}

function assertDisjoint(left, right, leftLabel, rightLabel) {
  for (const value of left) {
    if (right.has(value)) {
      throw new Error(`${value} cannot be in both ${leftLabel} and ${rightLabel}`);
    }
  }
}

function validateCoverageScope(coverageScope, source, sourceId) {
  if (!coverageScope || typeof coverageScope !== "object" || Array.isArray(coverageScope)) {
    throw new Error(`${sourceId}.coverageScope must be an object`);
  }
  const unmappedRawSnapshot = coverageScope.mappingStatus === "UNMAPPED_RAW_SNAPSHOT"
    && source.rawSnapshotAdmission != null
    && source.requiredForProductionPack === false
    && source.productionUseAllowed === false
    && ["facility", "schedule", "realtime"].every(
      (capability) => source.capabilities?.[capability]?.productionUseAllowed === false,
    );
  if (coverageScope.mappingStatus !== undefined && !unmappedRawSnapshot) {
    throw new Error(`${sourceId}.coverageScope.mappingStatus requires a non-production raw snapshot`);
  }
  if (source.rawSnapshotAdmission != null && coverageScope.mappingStatus !== "UNMAPPED_RAW_SNAPSHOT") {
    throw new Error(`${sourceId}.rawSnapshotAdmission requires UNMAPPED_RAW_SNAPSHOT coverage`);
  }
  const regionIds = assertStringArray(
    coverageScope.regionIds, `${sourceId}.coverageScope.regionIds`, { allowEmpty: unmappedRawSnapshot },
  );
  const operatorIds = assertStringArray(
    coverageScope.operatorIds, `${sourceId}.coverageScope.operatorIds`, { allowEmpty: unmappedRawSnapshot },
  );
  if (unmappedRawSnapshot && (regionIds.length !== 0 || operatorIds.length !== 0)) {
    throw new Error(`${sourceId}.rawSnapshotAdmission requires an explicit mapping ledger before internal coverage scope`);
  }
  assertStringArray(coverageScope.sourceDomains, `${sourceId}.coverageScope.sourceDomains`);
  if (coverageScope.lineIds !== undefined) {
    const lineIds = assertStringArray(coverageScope.lineIds, `${sourceId}.coverageScope.lineIds`);
    if (new Set(lineIds).size !== lineIds.length) {
      throw new Error(`${sourceId}.coverageScope.lineIds must not contain duplicates`);
    }
  }
}

function validateLicense(license, sourceId) {
  if (!license || typeof license !== "object" || Array.isArray(license)) {
    throw new Error(`${sourceId}.license must be an object`);
  }
  assertString(license.type, `${sourceId}.license.type`);
  if (!["KOGL-1", "PUBLIC_DATA_FREE_USE"].includes(license.type)) {
    throw new Error(`${sourceId}.license.type must be KOGL-1 or PUBLIC_DATA_FREE_USE`);
  }
  assertString(license.name, `${sourceId}.license.name`);
  assertString(license.attribution, `${sourceId}.license.attribution`);
  assertHttpsUrl(license.evidenceUrl, `${sourceId}.license.evidenceUrl`);

  for (const key of ["commercialUseAllowed", "derivativeWorkAllowed", "redistributionAllowed"]) {
    if (license[key] !== true) {
      throw new Error(`${sourceId}.license.${key} must be true`);
    }
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function assertStringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const entry of value) {
    assertString(entry, `${label}[]`);
  }
  return value;
}

function assertDate(value, label) {
  assertString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 hex string`);
  }
  return value;
}

function assertHttpsUrl(value, label) {
  assertString(value, label);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
}
