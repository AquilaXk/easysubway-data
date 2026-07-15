#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { deriveFreshness } from "./freshness-policy.mjs";
import { approvedLegacyGovernanceBinding } from "./legacy-source-governance.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import {
  evaluateSourceGovernance,
  validateSourceGovernancePolicy,
} from "./source-governance-policy.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import {
  purgeReportSha256,
  verifyPurgeAttestation,
} from "./source-raw-purge-attestation.mjs";

const buildProvenanceStringFields = [
  "snapshotId",
  "sourceId",
  "rawObjectUri",
  "redactedRequestFingerprint",
  "licenseStatus",
  "snapshotStatus",
];
const policyBoundProvenanceStringFields = [
  "freshnessExpiresAt",
  "rawRetentionExpiresAt",
  "governancePolicyVersion",
  "governancePolicySha256",
];
const buildProvenanceBooleanFields = ["redistributionAllowed", "credentialRedacted"];
const RELEASE_PROTECTION_REASONS = new Set(["ACTIVE_RELEASE", "ROLLBACK_WINDOW"]);
export function validateSourceSnapshotFreshness({
  buildSpec,
  snapshots,
  policy,
  evaluationAt,
  governancePolicy = null,
  inventory = null,
  governancePolicySha256 = null,
  purgeReport = null,
  purgeAttestation = null,
}) {
  if (!Array.isArray(buildSpec?.sourceSnapshotIds) || buildSpec.sourceSnapshotIds.length === 0) {
    throw new Error("SOURCE_FRESHNESS_POLICY_MISSING: buildSpec.sourceSnapshotIds");
  }
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error("SOURCE_FRESHNESS_POLICY_MISSING: source snapshots");
  }
  const { headsBySource } = validateLineage(snapshots);
  const selectedSnapshots = selectSnapshots(snapshots, buildSpec.sourceSnapshotIds);
  for (const snapshot of selectedSnapshots) {
    if (headsBySource[snapshot.sourceId] !== snapshot.snapshotId) {
      throw new Error("SOURCE_LINEAGE_BROKEN: selected snapshot is not source head");
    }
  }
  if (inventory != null) validateRequiredProductionSources(selectedSnapshots, inventory);
  const includeGovernance = governancePolicy != null;
  const evidenceProvenance = canonicalBuildProvenance(selectedSnapshots, "snapshots");
  const buildProvenance = canonicalBuildProvenance(
    buildSpec.sourceSnapshots,
    "buildSpec.sourceSnapshots",
  );
  if (JSON.stringify(evidenceProvenance) !== JSON.stringify(buildProvenance)) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot provenance");
  }
  const effectiveSnapshots = includeGovernance
    ? bindGovernanceProvenance(selectedSnapshots, buildSpec.sourceSnapshots)
    : selectedSnapshots;
  if (!includeGovernance) {
    const evidencePolicyProvenance = canonicalPolicyProvenance(selectedSnapshots, "snapshots", false);
    const buildPolicyProvenance = canonicalPolicyProvenance(
      buildSpec.sourceSnapshots,
      "buildSpec.sourceSnapshots",
      false,
    );
    if (JSON.stringify(evidencePolicyProvenance) !== JSON.stringify(buildPolicyProvenance)) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot provenance");
    }
  }
  const snapshotSetHash = sha256(JSON.stringify(selectedSnapshots));
  if (snapshotSetHash !== buildSpec.sourceSnapshotSetHash) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot set hash");
  }

  const results = effectiveSnapshots.map((snapshot) => {
    const sourceId = requiredString(snapshot.sourceId, "sourceId");
    const sourceClasses = policy?.sourceClasses?.filter((entry) => entry.sourceIds?.includes(sourceId)) ?? [];
    if (sourceClasses.length !== 1) {
      throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: ${sourceId}`);
    }
    const sourceClass = sourceClasses[0];
    return {
      snapshotId: snapshot.snapshotId,
      sourceClassId: sourceClass.id,
      ...deriveFreshness({
        policy,
        sourceClassId: sourceClass.id,
        basisAt: snapshot[sourceClass.basisField],
        providerValidUntil: sourceClass.providerValidityEndField
          ? snapshot[sourceClass.providerValidityEndField]
          : undefined,
        storedExpiresAt: snapshot.freshnessExpiresAt,
        evaluationAt,
      }),
    };
  });
  if (results.some((result) => result.status !== "FRESH")) {
    throw new Error("SOURCE_SNAPSHOT_EXPIRED");
  }
  let governanceResults = [];
  const purgeEvidence = purgeReport == null
    ? new Map()
    : purgeEvidenceBySnapshot(purgeReport, purgeAttestation);
  if (governancePolicy != null || inventory != null) {
    if (governancePolicy == null || inventory == null) {
      throw new Error("SOURCE_GOVERNANCE_OWNER_MISSING: governance policy and inventory are required together");
    }
    if (sha256(JSON.stringify(inventory)) !== requiredSha256(
      buildSpec.sourceInventorySha256,
      "buildSpec.sourceInventorySha256",
    )) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source inventory hash");
    }
    validateSourceGovernancePolicy({ policy: governancePolicy, inventory, freshnessPolicy: policy });
    if (!/^[0-9a-f]{64}$/.test(governancePolicySha256 ?? "")) {
      throw new Error("SOURCE_GOVERNANCE_OWNER_MISSING: governance policy hash");
    }
    if (effectiveSnapshots.some((snapshot) => (
      snapshot.governancePolicyVersion !== governancePolicy.policyVersion
      || snapshot.governancePolicySha256 !== governancePolicySha256
    ))) {
      throw new Error("SOURCE_FRESHNESS_POLICY_MISSING: governance policy binding");
    }
    const sources = new Map(inventory.sources.map((source) => [source.id, source]));
    governanceResults = effectiveSnapshots.map((snapshot) => {
      const rawState = purgeEvidence.get(`${snapshot.sourceId}\0${snapshot.snapshotId}`) ?? null;
      if (rawState?.protectedBy != null && rawState.rawSha256 !== snapshot.rawSha256) {
        throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge report protection raw hash");
      }
      return evaluateSourceGovernance({
        source: sources.get(snapshot.sourceId),
        snapshot,
        policy: governancePolicy,
        freshnessPolicy: policy,
        evaluationAt,
        purgeEvidence: rawState?.purgedAt == null ? null : rawState,
        protectedBy: rawState?.protectedBy ?? [],
        legalHold: rawState?.legalHold ?? null,
        protectionEvaluatedAt: rawState?.protectedAt ?? null,
      });
    });
    const reasonCodes = [...new Set(governanceResults.flatMap((result) => result.reasonCodes))].sort();
    if (reasonCodes.length > 0) throw new Error(reasonCodes.join(","));
  }
  return { snapshotSetHash, results, governanceResults };
}

async function main(argv) {
  const args = parseArgs(argv);
  const buildSpecPath = requiredArg(args, "build-spec");
  const policyPath = requiredArg(args, "policy");
  const buildSpec = JSON.parse(await readFile(buildSpecPath, "utf8"));
  const snapshotsPath = requiredString(
    buildSpec.sourceSnapshotEvidencePath,
    "buildSpec.sourceSnapshotEvidencePath",
  );
  const root = process.cwd();
  const resolvedEvidencePath = path.resolve(root, snapshotsPath);
  assertRepositoryRelativePath(path.relative(root, resolvedEvidencePath));
  const governancePolicyPath = args.get("governance-policy");
  const inventoryPath = args.get("inventory");
  if ((governancePolicyPath == null) !== (inventoryPath == null)) {
    throw new Error("--governance-policy and --inventory must be provided together");
  }
  const purgeReportPath = buildSpec.sourceRawPurgeReportPath;
  const [snapshotText, policy, governancePolicyText, inventory] = await Promise.all([
    readFile(resolvedEvidencePath, "utf8"),
    readFile(policyPath, "utf8").then(JSON.parse),
    governancePolicyPath ? readFile(governancePolicyPath, "utf8") : null,
    inventoryPath ? readFile(inventoryPath, "utf8").then(JSON.parse) : null,
  ]);
  const snapshots = JSON.parse(snapshotText);
  const governancePolicy = governancePolicyText ? JSON.parse(governancePolicyText) : null;
  const governancePolicySha256 = governancePolicyText ? sha256(governancePolicyText) : null;
  let purgeReport = null;
  let purgeAttestation = null;
  if (purgeReportPath != null) {
    if (governancePolicy == null || governancePolicySha256 == null) {
      throw new Error("SOURCE_FRESHNESS_POLICY_MISSING: purge governance policy");
    }
    const [purgeReportText, journalText, ledgerText, publicKeyText] = await Promise.all([
      readHashBoundArtifact(
        root,
        purgeReportPath,
        buildSpec.sourceRawPurgeReportSha256,
        "buildSpec.sourceRawPurgeReportPath",
      ),
      readHashBoundArtifact(
        root,
        buildSpec.sourceRawPurgeJournalPath,
        buildSpec.sourceRawPurgeJournalSha256,
        "buildSpec.sourceRawPurgeJournalPath",
      ),
      readHashBoundArtifact(
        root,
        buildSpec.sourceRawPurgeLedgerPath,
        buildSpec.sourceRawPurgeLedgerSha256,
        "buildSpec.sourceRawPurgeLedgerPath",
      ),
      readHashBoundArtifact(
        root,
        buildSpec.sourceRawPurgeAttestationPublicKeyPath,
        buildSpec.sourceRawPurgeAttestationPublicKeySha256,
        "buildSpec.sourceRawPurgeAttestationPublicKeyPath",
      ),
    ]);
    purgeReport = JSON.parse(purgeReportText);
    purgeAttestation = {
      journalText,
      ledgerText,
      snapshotText,
      governancePolicyVersion: governancePolicy.policyVersion,
      governancePolicySha256,
      publicKeyText,
      trustedPublicKeySha256:
        process.env.EASYSUBWAY_SOURCE_RAW_PURGE_ATTESTATION_PUBLIC_KEY_SHA256,
    };
  }
  if (purgeReport != null) {
    const suppliedPurgeEvaluationAt = new Date(requiredUtcInstant(
      requiredArg(args, "purge-evaluation-at"),
      "--purge-evaluation-at",
    )).toISOString();
    if (purgeReport.evaluatedAt !== suppliedPurgeEvaluationAt) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge report evaluation time");
    }
  }
  const result = validateSourceSnapshotFreshness({
    buildSpec,
    snapshots,
    policy,
    evaluationAt: args.get("evaluation-at") ?? new Date().toISOString(),
    governancePolicy,
    inventory,
    governancePolicySha256,
    purgeReport,
    purgeAttestation,
  });
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    sourceSnapshotSetHash: result.snapshotSetHash,
    snapshotCount: result.results.length,
    governanceDecision: result.governanceResults.length > 0 ? "GO" : "NOT_EVALUATED",
  })}\n`);
}

export function assertRepositoryRelativePath(relativePath) {
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("buildSpec.sourceSnapshotEvidencePath must stay within the repository");
  }
}

async function readRepositoryArtifact(root, artifactPath, label) {
  const relativePath = requiredString(artifactPath, label);
  const resolvedPath = path.resolve(root, relativePath);
  assertRepositoryRelativePath(path.relative(root, resolvedPath));
  return readFile(resolvedPath, "utf8");
}

async function readHashBoundArtifact(root, artifactPath, expectedHash, label) {
  const text = await readRepositoryArtifact(root, artifactPath, label);
  if (sha256(text) !== requiredSha256(expectedHash, `${label}Sha256`)) {
    throw new Error(`SOURCE_FRESHNESS_DERIVATION_MISMATCH: ${label} hash`);
  }
  return text;
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || value == null || value.startsWith("--")) {
      throw new Error(`invalid argument: ${token ?? "<end>"}`);
    }
    args.set(token.slice(2), value);
  }
  return args;
}

function requiredArg(args, name) {
  return requiredString(args.get(name), `--${name}`);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredSha256(value, label) {
  const normalized = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be sha256`);
  return normalized;
}

export function purgeEvidenceBySnapshot(report, attestation) {
  verifyPurgeAttestation(report, attestation ?? {});
  const expectedHash = purgeReportSha256(report);
  let completedMillis = Number.NaN;
  let evaluatedMillis = Number.NaN;
  try {
    completedMillis = requiredUtcInstant(report?.completedAt, "purge report completedAt");
    evaluatedMillis = requiredUtcInstant(report?.evaluatedAt, "purge report evaluatedAt");
  } catch {
    // The identity check below reports one stable contract error.
  }
  const pass = report?.decision === "PASS"
    && Array.isArray(report.reasonCodes)
    && report.reasonCodes.length === 0
    && Array.isArray(report.failed)
    && report.failed.length === 0;
  const partialFailure = report?.decision === "FAIL"
    && Array.isArray(report.reasonCodes)
    && report.reasonCodes.length === 1
    && report.reasonCodes[0] === "RAW_RETENTION_OVERDUE"
    && Array.isArray(report.failed)
    && report.failed.length > 0;
  if (report?.schemaVersion !== 1
    || report?.artifactKind !== "source-raw-purge-report"
    || report.dryRun !== false
    || report.reportSha256 !== expectedHash
    || (!pass && !partialFailure)
    || !Number.isFinite(completedMillis)
    || !Number.isFinite(evaluatedMillis)
    || completedMillis < evaluatedMillis
    || !Array.isArray(report.deleted)
    || !Array.isArray(report.alreadyAbsent)
    || !Array.isArray(report.protected)) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge report");
  }
  const purgedAt = new Date(completedMillis).toISOString();
  const evidence = new Map();
  const seen = new Set();
  for (const entry of [...report.deleted, ...report.alreadyAbsent]) {
    const sourceId = requiredString(entry?.sourceId, "purge report sourceId");
    const snapshotId = requiredString(entry?.snapshotId, "purge report snapshotId");
    const rawSha256 = requiredSha256(entry?.rawSha256, "purge report rawSha256");
    const key = `${sourceId}\0${snapshotId}`;
    if (seen.has(key)) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge report duplicate snapshot");
    }
    seen.add(key);
    evidence.set(key, { sourceId, snapshotId, rawSha256, purgedAt });
  }
  for (const entry of report.protected) {
    const sourceId = requiredString(entry?.sourceId, "purge report sourceId");
    const snapshotId = requiredString(entry?.snapshotId, "purge report snapshotId");
    const rawSha256 = requiredSha256(entry?.rawSha256, "purge report rawSha256");
    const protectedBy = entry?.protectedBy;
    const legalHold = entry?.legalHold ?? null;
    const key = `${sourceId}\0${snapshotId}`;
    if (seen.has(key)
      || !Array.isArray(protectedBy)
      || new Set(protectedBy).size !== protectedBy.length
      || !protectedBy.every((reason) => RELEASE_PROTECTION_REASONS.has(reason))
      || (protectedBy.length === 0 && legalHold == null)
      || (legalHold != null && (typeof legalHold !== "object" || Array.isArray(legalHold)))) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge report protection");
    }
    seen.add(key);
    evidence.set(key, {
      sourceId,
      snapshotId,
      rawSha256,
      protectedBy,
      legalHold,
      protectedAt: new Date(evaluatedMillis).toISOString(),
    });
  }
  for (const entry of report.failed) {
    const sourceId = requiredString(entry?.sourceId, "purge report sourceId");
    const snapshotId = requiredString(entry?.snapshotId, "purge report snapshotId");
    requiredSha256(entry?.rawSha256, "purge report rawSha256");
    const key = `${sourceId}\0${snapshotId}`;
    if (seen.has(key)) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge report duplicate snapshot");
    }
    seen.add(key);
  }
  return evidence;
}

function selectSnapshots(snapshots, selectedIds) {
  const ids = selectedIds.map((id, index) => requiredString(id, `buildSpec.sourceSnapshotIds[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot IDs");
  }
  const byId = new Map();
  for (const snapshot of snapshots) {
    const snapshotId = requiredString(snapshot?.snapshotId, "snapshotId");
    if (byId.has(snapshotId)) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot IDs");
    }
    byId.set(snapshotId, snapshot);
  }
  if (ids.some((id) => !byId.has(id))) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot IDs");
  }
  const selectedIdsSet = new Set(ids);
  return snapshots.filter((snapshot) => selectedIdsSet.has(snapshot.snapshotId));
}

function validateRequiredProductionSources(snapshots, inventory) {
  const counts = new Map();
  for (const snapshot of snapshots) {
    counts.set(snapshot.sourceId, (counts.get(snapshot.sourceId) ?? 0) + 1);
  }
  for (const source of inventory?.sources ?? []) {
    if (source.requiredForProductionPack === true && counts.get(source.id) !== 1) {
      throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: required production source ${source.id}`);
    }
  }
}

function bindGovernanceProvenance(snapshots, buildSnapshots) {
  const buildById = new Map(buildSnapshots.map((snapshot) => [snapshot?.snapshotId, snapshot]));
  return snapshots.map((snapshot, index) => {
    const buildSnapshot = buildById.get(snapshot.snapshotId);
    const hasPolicyBinding = snapshot.governancePolicyVersion != null
      || snapshot.governancePolicySha256 != null;
    if (hasPolicyBinding) {
      const evidence = canonicalPolicyProvenance([snapshot], `snapshots[${index}]`, true);
      const build = canonicalPolicyProvenance([buildSnapshot], `buildSpec.sourceSnapshots[${index}]`, true);
      if (JSON.stringify(evidence) !== JSON.stringify(build)) {
        throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot provenance");
      }
      return snapshot;
    }
    const approvedBinding = approvedLegacyGovernanceBinding(snapshot);
    if (approvedBinding == null) {
      throw new Error("SOURCE_FRESHNESS_POLICY_MISSING: governance policy binding");
    }
    const policyProvenance = canonicalPolicyProvenance(
      [buildSnapshot],
      `buildSpec.sourceSnapshots[${index}]`,
      true,
    )[0];
    if (policyProvenance.governancePolicyVersion !== approvedBinding.governancePolicyVersion
      || policyProvenance.governancePolicySha256 !== approvedBinding.governancePolicySha256) {
      throw new Error("SOURCE_FRESHNESS_POLICY_MISSING: governance policy binding");
    }
    return { ...snapshot, ...policyProvenance };
  });
}

function canonicalBuildProvenance(snapshots, label) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: ${label}`);
  }
  return snapshots.map((snapshot, index) => {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: ${label}[${index}]`);
    }
    const canonical = Object.fromEntries(buildProvenanceStringFields.map((field) => [
      field,
      requiredString(snapshot[field], `${label}[${index}].${field}`),
    ]));
    for (const field of buildProvenanceBooleanFields) {
      if (typeof snapshot[field] !== "boolean") {
        throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: ${label}[${index}].${field}`);
      }
      canonical[field] = snapshot[field];
    }
    return canonical;
  }).sort((left, right) => left.snapshotId.localeCompare(right.snapshotId));
}

function canonicalPolicyProvenance(snapshots, label, includeGovernance) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: ${label}`);
  }
  const fields = includeGovernance
    ? policyBoundProvenanceStringFields
    : policyBoundProvenanceStringFields.filter((field) => !field.startsWith("governancePolicy"));
  return snapshots.map((snapshot, index) => ({
    snapshotId: requiredString(snapshot?.snapshotId, `${label}[${index}].snapshotId`),
    provenance: Object.fromEntries(fields.map((field) => [
      field,
      requiredString(snapshot?.[field], `${label}[${index}].${field}`),
    ])),
  }))
    .sort((left, right) => left.snapshotId.localeCompare(right.snapshotId))
    .map((entry) => entry.provenance);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
