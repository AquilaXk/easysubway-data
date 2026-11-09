#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { publishSourceRawObject, validateSourceRawObjectReceipt } from "./lib/source-raw-object-publication.mjs";
import { requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";
import {
  buildAppendOnlyGovernancePolicyRegistration,
  deriveRawRetentionExpiresAt,
  validateSourceGovernancePolicy,
} from "./source-governance-policy.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";

const LABEL = "Incheon source";
const PROVIDER = "인천교통공사";
const REVIEWED_AT = "2026-10-01T00:00:00.000Z";
const NEXT_REVIEW_AT = "2027-10-01T00:00:00.000Z";
const OWNER_ROLE = "datapack-source-owner";
const STEWARD_ROLE = "datapack-data-steward";
const APPROVAL_ROLE = "datapack-release-approver";
const ESCALATION_HOURS = 4;
const ALERT_ROUTE = "github:area-datapack";
const REDISTRIBUTION_SCOPES = Object.freeze(["DERIVED_DATAPACK"]);
const RETENTION_CLASS_ID = "standard-90d";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const INCHEON_DATAPACK_SOURCE_SPECS = Object.freeze([
  Object.freeze({
    sourceId: "incheon-transit-station-info",
    sourceClassId: "route_graph_topology",
    retentionClassId: RETENTION_CLASS_ID,
    admissionKind: "topologyAdmissionEvidence",
    artifactKind: "incheon-station-info-snapshot",
    rowCountOf: (snapshot) => snapshot?.edgeCount,
    coverageCountOf: (_snapshot, evidence) => evidence?.stationCount,
  }),
  Object.freeze({
    sourceId: "incheon-line1-train-timetable",
    sourceClassId: "incheon_timetable_observation",
    retentionClassId: RETENTION_CLASS_ID,
    admissionKind: "scheduleAdmissionEvidence",
    artifactKind: "incheon-train-timetable-snapshot",
    rowCountOf: (snapshot) => snapshot?.rowCount,
    coverageCountOf: (_snapshot, evidence) => evidence?.departureCount,
  }),
  Object.freeze({
    sourceId: "incheon-line2-train-timetable",
    sourceClassId: "incheon_timetable_observation",
    retentionClassId: RETENTION_CLASS_ID,
    admissionKind: "scheduleAdmissionEvidence",
    artifactKind: "incheon-train-timetable-snapshot",
    rowCountOf: (snapshot) => snapshot?.rowCount,
    coverageCountOf: (_snapshot, evidence) => evidence?.departureCount,
  }),
]);

export const INCHEON_DATAPACK_SOURCE_IDS = Object.freeze(
  INCHEON_DATAPACK_SOURCE_SPECS.map(({ sourceId }) => sourceId),
);

const SPEC_BY_SOURCE_ID = new Map(
  INCHEON_DATAPACK_SOURCE_SPECS.map((spec) => [spec.sourceId, spec]),
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`${LABEL} ${label} is invalid JSON`);
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${LABEL} ${label} must be absolute`);
  }
  return path.resolve(value);
}

function isUtcInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function indexUniqueByKey(items, keySelector, label) {
  if (!Array.isArray(items)) throw new Error(`${LABEL} ${label} must be an array`);
  const map = new Map();
  for (const item of items) {
    const key = keySelector(item);
    if (typeof key !== "string" || key.length === 0 || map.has(key)) {
      throw new Error(`${LABEL} ${label} has missing or duplicate key: ${String(key)}`);
    }
    map.set(key, item);
  }
  return map;
}

function buildGovernanceEntry(source, spec, termsHash, now) {
  const license = source?.license;
  if (!source || source.requiredForProductionPack !== false || source.productionUseAllowed !== true
    || source.provider !== PROVIDER || typeof source.datasetUrl !== "string" || !source.datasetUrl.startsWith("https://")
    || !license || license.type !== "PUBLIC_DATA_FREE_USE" || license.commercialUseAllowed !== true
    || license.derivativeWorkAllowed !== true || license.redistributionAllowed !== true
    || license.evidenceUrl !== source.datasetUrl
    || Date.parse(REVIEWED_AT) > now.valueOf() || Date.parse(NEXT_REVIEW_AT) <= now.valueOf()) {
    throw new Error(`${LABEL} license is invalid for ${spec.sourceId}`);
  }
  return {
    sourceId: spec.sourceId,
    sourceClassId: spec.sourceClassId,
    retentionClassId: spec.retentionClassId,
    ownerRole: OWNER_ROLE,
    stewardRole: STEWARD_ROLE,
    approvalRole: APPROVAL_ROLE,
    escalationHours: ESCALATION_HOURS,
    alertRoute: ALERT_ROUTE,
    licenseReview: {
      status: "APPROVED",
      termsHash,
      reviewedAt: REVIEWED_AT,
      nextReviewAt: NEXT_REVIEW_AT,
      termsUrl: license.evidenceUrl,
      reviewedProvider: source.provider,
      reviewedDatasetUrl: source.datasetUrl,
      redistributionScopes: [...REDISTRIBUTION_SCOPES],
      approvedByRole: APPROVAL_ROLE,
    },
  };
}

export function buildIncheonInventoryAndGovernance({
  inventoryBytes,
  governanceBytes,
  freshnessPolicy,
  now = new Date(),
} = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error(`${LABEL} registration time is invalid`);
  }
  const inventory = parseJson(inventoryBytes, "inventory");
  const governance = parseJson(governanceBytes, "governance policy");
  const sourceById = indexUniqueByKey(inventory?.sources, (source) => source?.id, "inventory sources");
  const governanceById = indexUniqueByKey(governance?.sources, (entry) => entry?.sourceId, "governance sources");

  const termsHashBySourceId = new Map();
  const desiredGovernanceEntries = [];
  for (const spec of INCHEON_DATAPACK_SOURCE_SPECS) {
    const source = sourceById.get(spec.sourceId);
    if (!source) throw new Error(`${LABEL} inventory source missing for ${spec.sourceId}`);
    const termsHash = sha256(canonicalJson(source.license));
    termsHashBySourceId.set(spec.sourceId, termsHash);
    desiredGovernanceEntries.push(buildGovernanceEntry(source, spec, termsHash, now));
  }

  const nextInventory = {
    ...inventory,
    sources: inventory.sources.map((source) => {
      const termsHash = termsHashBySourceId.get(source.id);
      if (!termsHash) return source;
      return {
        ...source,
        admissionEvidence: { licenseEvidenceHash: termsHash },
      };
    }),
  };

  const existingCount = desiredGovernanceEntries.filter(({ sourceId }) => governanceById.has(sourceId)).length;
  let nextGovernance;
  let nextGovernanceBytes;
  if (existingCount === 0) {
    const registered = buildAppendOnlyGovernancePolicyRegistration({
      predecessorPolicyBytes: Buffer.from(governanceBytes),
      addedSources: desiredGovernanceEntries,
    });
    nextGovernance = registered.policy;
    nextGovernanceBytes = registered.bytes;
  } else if (existingCount === desiredGovernanceEntries.length) {
    for (const desired of desiredGovernanceEntries) {
      if (!isDeepStrictEqual(governanceById.get(desired.sourceId), desired)) {
        throw new Error(`${LABEL} existing governance entry mismatch for ${desired.sourceId}`);
      }
    }
    nextGovernance = governance;
    nextGovernanceBytes = jsonBytes(governance);
  } else {
    throw new Error(`${LABEL} governance policy has partial Incheon registration`);
  }

  validateSourceGovernancePolicy({
    policy: nextGovernance,
    inventory: nextInventory,
    freshnessPolicy,
  });

  return {
    inventory: nextInventory,
    inventoryBytes: jsonBytes(nextInventory),
    governance: nextGovernance,
    governanceBytes: nextGovernanceBytes,
    governanceSha256: sha256(nextGovernanceBytes),
  };
}

function receiptTargetFor({ sourceId, capturedAt, rawObjectSha256, env }) {
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const match = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u.exec(baseUrl.pathname);
  const [, ociNamespace, bucket] = match ?? [];
  const capturedDate = capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${sourceId}/${capturedDate}/${rawObjectSha256}.json`;
  return {
    baseUrl,
    ociNamespace,
    bucket,
    objectKey,
    rawObjectUri: `oci://${ociNamespace}/${bucket}/${objectKey}`,
  };
}

function canonicalObservedAt(value) {
  if (isUtcInstant(value)) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const candidate = `${value}T00:00:00.000Z`;
    if (isUtcInstant(candidate)) return candidate;
  }
  return null;
}

export async function prepareIncheonDatapackSourceRegistration({
  repositoryRoot,
  inventoryBytes,
  governanceBytes,
  freshnessBytes,
  ledgerBytes,
  now = new Date(),
} = {}) {
  const root = assertAbsolutePath(repositoryRoot, "repository root");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error(`${LABEL} registration time is invalid`);
  }
  const [rawInventory, rawGovernance, rawFreshness, rawLedger] = await Promise.all([
    inventoryBytes ?? readFile(path.join(root, "tools/datapack/source-inventory.json")),
    governanceBytes ?? readFile(path.join(root, "tools/datapack/source-governance-policy.json")),
    freshnessBytes ?? readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json")),
    ledgerBytes ?? readFile(path.join(root, "tools/datapack/release/source-snapshots.json")),
  ]);
  const freshness = parseJson(rawFreshness, "freshness policy");
  const ledger = parseJson(rawLedger, "source snapshots ledger");
  if (!Array.isArray(ledger)) throw new Error(`${LABEL} source snapshots ledger must be an array`);
  validateLineage(ledger);

  const {
    inventory,
    inventoryBytes: nextInventoryBytes,
    governance,
    governanceBytes: nextGovernanceBytes,
    governanceSha256,
  } = buildIncheonInventoryAndGovernance({
    inventoryBytes: rawInventory,
    governanceBytes: rawGovernance,
    freshnessPolicy: freshness,
    now,
  });

  const sourceById = indexUniqueByKey(inventory.sources, (source) => source.id, "inventory sources");
  const items = [];
  for (const spec of INCHEON_DATAPACK_SOURCE_SPECS) {
    const source = sourceById.get(spec.sourceId);
    const evidence = source?.[spec.admissionKind];
    const snapshotId = evidence?.snapshotId;
    const expectedRelative = `tools/datapack/sources/${snapshotId}.json`;
    const expectedObservedAt = canonicalObservedAt(source?.observedDataUpdatedAt);
    if (!evidence || typeof snapshotId !== "string" || snapshotId.length === 0
      || evidence.snapshotPath !== expectedRelative
      || !SHA256_PATTERN.test(evidence.rawSha256 ?? "")
      || !SHA256_PATTERN.test(evidence.contentSha256 ?? "")
      || !isUtcInstant(evidence.capturedAt) || !expectedObservedAt || !isUtcInstant(evidence.freshUntil)) {
      throw new Error(`${LABEL} admission evidence is invalid for ${spec.sourceId}`);
    }
    const snapshotFile = path.join(root, expectedRelative);
    const snapshotBytes = await readFile(snapshotFile);
    const snapshot = parseJson(snapshotBytes, `${spec.sourceId} snapshot`);
    const rawObjectSha256 = sha256(snapshotBytes);
    const rowCount = spec.rowCountOf(snapshot);
    const coverageCount = spec.coverageCountOf(snapshot, evidence);
    const datasetIds = Array.isArray(snapshot?.datasetIds)
      ? snapshot.datasetIds
      : (typeof snapshot?.datasetId === "string" && snapshot.datasetId.length > 0 ? [snapshot.datasetId] : []);
    if (snapshot?.artifactKind !== spec.artifactKind || snapshot.sourceId !== spec.sourceId
      || snapshot.rawSha256 !== evidence.rawSha256 || snapshot.contentSha256 !== evidence.contentSha256
      || snapshot.capturedAt !== evidence.capturedAt || snapshot.observedDataUpdatedAt !== source.observedDataUpdatedAt
      || snapshot.freshUntil !== evidence.freshUntil
      || !Number.isInteger(rowCount) || rowCount <= 0
      || !Number.isInteger(coverageCount) || coverageCount <= 0
      || typeof snapshot.detailUrl !== "string" || datasetIds.length === 0) {
      throw new Error(`${LABEL} snapshot binding mismatch for ${spec.sourceId}`);
    }
    if (now.valueOf() < Date.parse(snapshot.capturedAt)) {
      throw new Error(`${LABEL} snapshot freshness is not current for ${spec.sourceId}`);
    }
    const freshnessExpiresAt = deriveFreshnessExpiresAt({
      policy: freshness,
      sourceClassId: spec.sourceClassId,
      basisAt: snapshot.capturedAt,
      evaluationAt: now.toISOString(),
    });
    if (now.valueOf() >= Date.parse(freshnessExpiresAt)) {
      throw new Error(`${LABEL} snapshot freshness is not current for ${spec.sourceId}`);
    }
    const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({
      policy: governance,
      sourceId: spec.sourceId,
      retrievedAt: snapshot.capturedAt,
    });
    items.push({
      spec,
      source,
      evidence,
      snapshotId,
      snapshotFile,
      snapshotRelative: expectedRelative,
      snapshotBytes,
      snapshot,
      datasetIds,
      observedAt: expectedObservedAt,
      rawObjectSha256,
      rowCount,
      coverageCount,
      freshnessExpiresAt,
      rawRetentionExpiresAt,
    });
  }

  return {
    root,
    now,
    inventory,
    inventoryBytes: nextInventoryBytes,
    governance,
    governanceBytes: nextGovernanceBytes,
    governanceSha256,
    freshness,
    ledger,
    items,
  };
}

export function buildIncheonSnapshotLedgerRow({
  item,
  receipt,
  target,
  governancePolicyVersion,
  governancePolicySha256,
  previousRow = null,
  now,
}) {
  const {
    spec,
    source,
    evidence,
    snapshotId,
    snapshotBytes,
    snapshot,
    datasetIds,
    observedAt,
    rawObjectSha256,
    rowCount,
    coverageCount,
    freshnessExpiresAt,
    rawRetentionExpiresAt,
  } = item;
  validateSourceRawObjectReceipt({
    receipt,
    target,
    now,
    label: LABEL,
    expected: {
      sourceId: spec.sourceId,
      snapshotId,
      capturedAt: snapshot.capturedAt,
      rawObjectSha256,
      byteSize: snapshotBytes.length,
      rawRetentionExpiresAt,
    },
  });
  const schemaFingerprint = sha256(canonicalJson({
    artifactKind: snapshot.artifactKind,
    keys: Object.keys(snapshot).sort(),
  }));
  const redactedRequestFingerprint = sha256(canonicalJson({
    detailUrl: snapshot.detailUrl,
    downloadUrl: snapshot.downloadUrl ?? null,
    datasetIds,
  }));
  const row = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: spec.sourceId,
    snapshotId,
    previousSnapshotId: previousRow?.snapshotId ?? null,
    capturedAt: snapshot.capturedAt,
    retrievedAt: snapshot.capturedAt,
    observedAt,
    sourceUpdatedAt: observedAt,
    provider: source.provider,
    rowCount,
    coverageCount,
    rawSha256: snapshot.rawSha256,
    contentSha256: snapshot.contentSha256,
    rawObjectUri: receipt.rawObjectUri,
    rawObjectSha256,
    byteSize: snapshotBytes.length,
    freshUntil: snapshot.freshUntil,
    freshnessExpiresAt,
    rawRetentionExpiresAt,
    governancePolicyVersion,
    governancePolicySha256,
    schemaFingerprint,
    redactedRequestFingerprint,
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    diffSummary: null,
    admissionEvidence: {
      licenseEvidenceHash: source.admissionEvidence.licenseEvidenceHash,
    },
    admissionRecordSha256s: [
      {
        kind: spec.admissionKind,
        sha256: sha256(canonicalJson(evidence)),
      },
    ],
  };
  row.diffSummary = previousRow ? buildSnapshotDiff(previousRow, row) : null;
  return row;
}

export async function publishAndRegisterIncheonDatapackSources({
  env = process.env,
  client = null,
  writeFiles = false,
  ...options
} = {}) {
  const prepared = await prepareIncheonDatapackSourceRegistration(options);
  const existingSnapshotIds = new Set(prepared.ledger.map((row) => row?.snapshotId));
  for (const item of prepared.items) {
    if (existingSnapshotIds.has(item.snapshotId)) {
      throw new Error(`${LABEL} snapshot is already registered: ${item.snapshotId}`);
    }
  }

  const headsBySource = validateLineage(prepared.ledger).headsBySource;
  const rowBySnapshotId = new Map(prepared.ledger.map((row) => [row.snapshotId, row]));
  const addedRows = [];

  for (const item of prepared.items) {
    const target = receiptTargetFor({
      sourceId: item.spec.sourceId,
      capturedAt: item.snapshot.capturedAt,
      rawObjectSha256: item.rawObjectSha256,
      env,
    });
    await publishSourceRawObject({
      sourcePath: item.snapshotFile,
      sha256: item.rawObjectSha256,
      sizeBytes: item.snapshotBytes.length,
      target,
      baseUrl: target.baseUrl,
      client,
      label: `${LABEL} (${item.spec.sourceId})`,
    });
    const receipt = {
      schemaVersion: 1,
      artifactKind: "static-network-source-raw-object-receipt",
      sourceId: item.spec.sourceId,
      snapshotId: item.snapshotId,
      capturedAt: item.snapshot.capturedAt,
      rawObjectUri: target.rawObjectUri,
      rawObjectSha256: item.rawObjectSha256,
      byteSize: item.snapshotBytes.length,
      storedAt: prepared.now.toISOString(),
      rawRetentionExpiresAt: item.rawRetentionExpiresAt,
      ociNamespace: target.ociNamespace,
      bucket: target.bucket,
      objectKey: target.objectKey,
      contentType: "application/json",
    };
    const previousHeadId = headsBySource[item.spec.sourceId];
    const previousRow = previousHeadId ? rowBySnapshotId.get(previousHeadId) ?? null : null;
    const row = buildIncheonSnapshotLedgerRow({
      item,
      receipt,
      target,
      governancePolicyVersion: prepared.governance.policyVersion,
      governancePolicySha256: prepared.governanceSha256,
      previousRow,
      now: prepared.now,
    });
    addedRows.push(row);
  }

  const nextLedger = [...prepared.ledger, ...addedRows];
  validateLineage(nextLedger);
  const nextLedgerBytes = jsonBytes(nextLedger);

  if (writeFiles) {
    await Promise.all([
      writeFile(path.join(prepared.root, "tools/datapack/source-inventory.json"), prepared.inventoryBytes),
      writeFile(path.join(prepared.root, "tools/datapack/source-governance-policy.json"), prepared.governanceBytes),
      writeFile(path.join(prepared.root, "tools/datapack/release/source-snapshots.json"), nextLedgerBytes),
    ]);
  }

  return {
    inventory: prepared.inventory,
    inventoryBytes: prepared.inventoryBytes,
    governance: prepared.governance,
    governanceBytes: prepared.governanceBytes,
    ledger: nextLedger,
    ledgerBytes: nextLedgerBytes,
    addedRows,
  };
}

export { SPEC_BY_SOURCE_ID };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const writeFiles = process.argv.includes("--write");
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  publishAndRegisterIncheonDatapackSources({ repositoryRoot, writeFiles })
    .then(({ addedRows }) => {
      console.log(JSON.stringify({
        registeredSourceIds: addedRows.map(({ sourceId }) => sourceId),
        registeredSnapshotIds: addedRows.map(({ snapshotId }) => snapshotId),
      }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : `${LABEL} registration failed`);
      process.exitCode = 1;
    });
}
