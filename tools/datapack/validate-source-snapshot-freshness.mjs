#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { deriveFreshness } from "./freshness-policy.mjs";

const buildProvenanceStringFields = [
  "snapshotId",
  "sourceId",
  "rawObjectUri",
  "redactedRequestFingerprint",
  "licenseStatus",
  "snapshotStatus",
  "freshnessExpiresAt",
];
const buildProvenanceBooleanFields = ["redistributionAllowed", "credentialRedacted"];

export function validateSourceSnapshotFreshness({ buildSpec, snapshots, policy, evaluationAt }) {
  if (!Array.isArray(buildSpec?.sourceSnapshotIds) || buildSpec.sourceSnapshotIds.length === 0) {
    throw new Error("SOURCE_FRESHNESS_POLICY_MISSING: buildSpec.sourceSnapshotIds");
  }
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error("SOURCE_FRESHNESS_POLICY_MISSING: source snapshots");
  }
  const expectedIds = [...buildSpec.sourceSnapshotIds].sort();
  const actualIds = snapshots.map((snapshot) => requiredString(snapshot.snapshotId, "snapshotId")).sort();
  if (new Set(actualIds).size !== actualIds.length || JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot IDs");
  }
  const evidenceProvenance = canonicalBuildProvenance(snapshots, "snapshots");
  const buildProvenance = canonicalBuildProvenance(
    buildSpec.sourceSnapshots,
    "buildSpec.sourceSnapshots",
  );
  if (JSON.stringify(evidenceProvenance) !== JSON.stringify(buildProvenance)) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot provenance");
  }
  const snapshotSetHash = sha256(JSON.stringify(snapshots));
  if (snapshotSetHash !== buildSpec.sourceSnapshotSetHash) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: source snapshot set hash");
  }

  const results = snapshots.map((snapshot) => {
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
  return { snapshotSetHash, results };
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
  const [snapshots, policy] = await Promise.all([
    readFile(resolvedEvidencePath, "utf8").then(JSON.parse),
    readFile(policyPath, "utf8").then(JSON.parse),
  ]);
  const result = validateSourceSnapshotFreshness({
    buildSpec,
    snapshots,
    policy,
    evaluationAt: args.get("evaluation-at") ?? new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    sourceSnapshotSetHash: result.snapshotSetHash,
    snapshotCount: result.results.length,
  })}\n`);
}

export function assertRepositoryRelativePath(relativePath) {
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("buildSpec.sourceSnapshotEvidencePath must stay within the repository");
  }
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
