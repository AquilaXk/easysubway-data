#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveFreshness } from "./freshness-policy.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import {
  buildSnapshotDiff,
  requiredCredentialFreeObjectUri,
} from "./source-snapshot-policy.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const DEFAULT_FRESHNESS_POLICY = "apps/mobile/release/datapack-freshness-sla.json";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readRaw(args);
  assertNoCredential(raw);
  const canonicalRaw = canonicalizeRaw(raw);
  const records = rowsFromRaw(canonicalRaw);
  const previousSnapshot = args["previous-snapshot"]
    ? JSON.parse(await readFile(path.resolve(args["previous-snapshot"]), "utf8"))
    : null;
  if (args["previous-snapshot-id"] != null || args["diff-summary"] != null) {
    throw new Error("previous snapshot identity and diff must be producer-generated");
  }
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    snapshotId: requireArg(args, "snapshot-id"),
    sourceId: requireArg(args, "source-id"),
    provider: requireArg(args, "provider"),
    retrievedAt: requireArg(args, "retrieved-at"),
    sourceUpdatedAt: args["source-updated-at"] ?? null,
    rowCount: records.length,
    coverageCount: requiredNonNegativeInteger(args["coverage-count"], "--coverage-count"),
    rawSha256: sha256(canonicalRaw),
    rawObjectUri: requiredCredentialFreeObjectUri(args["raw-object-uri"], "--raw-object-uri"),
    redactedRequestFingerprint: sha256(redactedRequest(args)),
    schemaFingerprint: sha256(JSON.stringify(schemaFields(records))),
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    previousSnapshotId: null,
    diffSummary: null,
    freshnessExpiresAt: requireArg(args, "freshness-expires-at"),
    rawRetentionExpiresAt: args["governance-policy"] ? null : requireArg(args, "raw-retention-expires-at"),
    providerRecordHashes: records.map((record) => sha256(JSON.stringify(record))),
  };
  await validateFreshnessPolicy(snapshot, args);
  if (previousSnapshot != null) {
    if (previousSnapshot.sourceId !== snapshot.sourceId) {
      throw new Error("SOURCE_LINEAGE_BROKEN: previous snapshot source");
    }
    if (requiredUtcInstant(snapshot.retrievedAt, "snapshot.retrievedAt")
      <= requiredUtcInstant(previousSnapshot.retrievedAt, "previousSnapshot.retrievedAt")) {
      throw new Error("SOURCE_LINEAGE_BROKEN: retrievedAt order");
    }
    snapshot.previousSnapshotId = requiredText(previousSnapshot.snapshotId, "previousSnapshot.snapshotId");
    snapshot.diffSummary = buildSnapshotDiff(previousSnapshot, snapshot);
  }
  await validateRetentionPolicy(snapshot, args);
  validateSnapshot(snapshot);

  if (args["raw-output"]) {
    await writeFileWithParents(args["raw-output"], canonicalRaw);
  }
  await writeFileWithParents(requireArg(args, "output"), `${JSON.stringify(snapshot, null, 2)}\n`);
}

async function validateRetentionPolicy(snapshot, args) {
  if (!args["governance-policy"]) return;
  const policyBytes = await readFile(path.resolve(args["governance-policy"]));
  const policy = JSON.parse(policyBytes.toString("utf8"));
  const derived = deriveRawRetentionExpiresAt({
    policy,
    sourceId: snapshot.sourceId,
    retrievedAt: snapshot.retrievedAt,
  });
  if (
    args["raw-retention-expires-at"] != null
    && Date.parse(args["raw-retention-expires-at"]) !== Date.parse(derived)
  ) {
    throw new Error("RAW_RETENTION_OVERDUE: raw retention derivation mismatch");
  }
  snapshot.rawRetentionExpiresAt = derived;
  snapshot.governancePolicyVersion = requiredText(policy.policyVersion, "governance policy version");
  snapshot.governancePolicySha256 = sha256(policyBytes);
}

async function validateFreshnessPolicy(snapshot, args) {
  const policyPath = path.resolve(args["freshness-policy"] ?? DEFAULT_FRESHNESS_POLICY);
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  const sourceClassId = requireArg(args, "source-class-id");
  const sourceId = requireArg(args, "source-id");
  const sourceClasses = policy.sourceClasses?.filter((entry) => entry.sourceIds?.includes(sourceId)) ?? [];
  if (sourceClasses.length !== 1 || sourceClasses[0].id !== sourceClassId) {
    throw new Error(`SOURCE_FRESHNESS_POLICY_MISSING: ${sourceId} source class`);
  }
  const sourceClass = sourceClasses[0];
  const basisAt = args["freshness-basis-at"]
    ?? (sourceClass?.basisField === "retrievedAt" ? snapshot.retrievedAt : null);
  if (sourceClass?.basisField && basisAt) {
    snapshot[sourceClass.basisField] = basisAt;
  }
  if (sourceClass?.providerValidityEndField) {
    snapshot[sourceClass.providerValidityEndField] = requireArg(args, "provider-valid-until");
  }
  deriveFreshness({
    policy,
    sourceClassId,
    basisAt,
    providerValidUntil: sourceClass?.providerValidityEndField
      ? snapshot[sourceClass.providerValidityEndField]
      : args["provider-valid-until"],
    storedExpiresAt: snapshot.freshnessExpiresAt,
    evaluationAt: snapshot.retrievedAt,
  });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`unknown argument: ${key}`);
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
}

async function readRaw(args) {
  if ((args.input == null) === (args.url == null)) {
    throw new Error("exactly one of --input or --url is required");
  }
  if (args.input != null) {
    return readFile(path.resolve(args.input), "utf8");
  }
  const response = await fetch(args.url);
  if (!response.ok) {
    throw new Error(`source fetch failed: ${response.status}`);
  }
  return response.text();
}

function canonicalizeRaw(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("raw snapshot must not be empty");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return `${JSON.stringify(sortJson(JSON.parse(trimmed)))}\n`;
  }
  return `${trimmed.replace(/\r\n/g, "\n")}\n`;
}

function rowsFromRaw(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed).map(sortJson);
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    const array = Object.values(json).find(Array.isArray);
    return (array ?? [json]).map(sortJson);
  }
  const lines = trimmed.split("\n").filter(Boolean);
  if (lines.length === 0) return [];
  if (lines[0].includes(",")) {
    const headers = lines[0].split(",").map((value) => value.trim());
    return lines.slice(1).map((line) => Object.fromEntries(line.split(",").map((value, index) => [
      headers[index] ?? `column${index + 1}`,
      value.trim(),
    ])));
  }
  return lines.map((line) => ({ value: line }));
}

function schemaFields(records) {
  return [...new Set(records.flatMap((record) => Object.keys(record)))]
    .sort((left, right) => left.localeCompare(right));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [
    key,
    sortJson(entry),
  ]));
}

function redactedRequest(args) {
  return JSON.stringify(sortJson({
    input: args.input ? path.basename(args.input) : undefined,
    url: args.url ? args.url.replace(/([?&](?:serviceKey|apiKey|key|token)=)[^&#]*/gi, "$1[REDACTED]") : undefined,
    sourceId: args["source-id"],
  }));
}

function assertNoCredential(raw) {
  if (/(serviceKey|apiKey|access[_-]?token|secret)[=:][^\s&"']+/i.test(raw)) {
    throw new Error("raw snapshot contains credential-like token");
  }
}

function validateSnapshot(snapshot) {
  if (!/^[0-9a-f]{64}$/.test(snapshot.rawSha256) || !/^[0-9a-f]{64}$/.test(snapshot.schemaFingerprint)) {
    throw new Error("snapshot hash fields must be sha256");
  }
  const retrievedAt = requiredDate(snapshot.retrievedAt, "retrievedAt");
  if (requiredDate(snapshot.freshnessExpiresAt, "freshnessExpiresAt") <= retrievedAt) {
    throw new Error("freshnessExpiresAt must be after retrievedAt");
  }
  if (requiredDate(snapshot.rawRetentionExpiresAt, "rawRetentionExpiresAt") <= retrievedAt) {
    throw new Error("rawRetentionExpiresAt must be after retrievedAt");
  }
}

async function writeFileWithParents(filePath, body) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, body);
}

function requiredDate(value, label) {
  const millis = Date.parse(requiredText(value, label));
  if (Number.isNaN(millis)) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return millis;
}

function requiredNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function requireArg(args, name) {
  return requiredText(args[name], `--${name}`);
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
