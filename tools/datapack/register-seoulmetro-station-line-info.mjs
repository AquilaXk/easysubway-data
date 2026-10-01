#!/usr/bin/env node
// #862 결정 3a: seoulmetro-station-line-info 원장 등록기.
// 공식 수집기(revalidate-current-static-network-sources.mjs)의 NO_CHANGE 재검증 산출물을 원장 행과
// inventory admission evidence로 등록한다. 내용이 바뀐 관측은 변경 admission(검토) 경로가 맡으므로 여기서 받지 않는다.
// 결정 C: 후보 spec·release request·hash evidence는 쓰지 않는다.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { createSourceRegistrationTransaction, SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import { deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_ID = "seoulmetro-station-line-info";
const EVIDENCE_FILE = `${SOURCE_ID}-revalidation-evidence.json`;
const SNAPSHOT_FILE = `${SOURCE_ID}-snapshot.json`;
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const OVERRIDDEN_FIELDS = Object.freeze([
  "snapshotId", "retrievedAt", "coverageCount", "previousSnapshotId", "diffSummary",
  "freshnessExpiresAt", "rawRetentionExpiresAt", "revalidationEvidenceSha256",
]);
const EVIDENCE_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "contractVersion", "sourceId", "previousSnapshotId", "observedAt", "operation",
  "rowCount", "canonicalRawSha256", "schemaFingerprint", "providerRecordHashesSha256", "responseSha256", "outcome",
  "credentialRedacted", "evidenceSha256",
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = (message) => { throw new Error(`${SOURCE_ID} registration: ${message}`); };

function parse(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { return fail(`${label} is invalid JSON`); }
}
function instant(value, label) {
  const millis = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(millis) || new Date(millis).toISOString() !== value) fail(`${label} is invalid`);
  return millis;
}
function one(items, predicate, label) {
  const matches = Array.isArray(items) ? items.filter(predicate) : [];
  if (matches.length !== 1) fail(`${label} is missing or ambiguous`);
  return matches[0];
}

async function readRevalidationDirectory(directory, repositoryRoot) {
  if (!path.isAbsolute(directory ?? "")) fail("revalidation directory must be absolute");
  const resolved = path.resolve(directory);
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`)) fail("revalidation directory must be outside the repository");
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("revalidation directory must be a regular directory");
  const names = (await readdir(resolved)).sort();
  if (!isDeepStrictEqual(names, [EVIDENCE_FILE, SNAPSHOT_FILE].sort())) fail("revalidation directory inventory is invalid");
  const read = async (name) => {
    const file = path.join(resolved, name); const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) fail(`${name} must be a regular file`);
    return { absolute: file, bytes: await readFile(file) };
  };
  return { evidenceFile: await read(EVIDENCE_FILE), snapshotFile: await read(SNAPSHOT_FILE) };
}

function validateEvidence(evidence, head) {
  const { evidenceSha256, ...payload } = evidence ?? {};
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || !isDeepStrictEqual(Object.keys(evidence).sort(), [...EVIDENCE_KEYS].sort())
    || evidence.schemaVersion !== 1 || evidence.artifactKind !== "current-static-source-revalidation-evidence"
    || evidence.sourceId !== SOURCE_ID || evidence.outcome !== "NO_CHANGE_REVALIDATED" || evidence.credentialRedacted !== true
    || evidenceSha256 !== sha(JSON.stringify(payload))
    || evidence.previousSnapshotId !== head.snapshotId || evidence.canonicalRawSha256 !== head.rawSha256
    || evidence.schemaFingerprint !== head.schemaFingerprint || evidence.rowCount !== head.rowCount) {
    fail("revalidation evidence is invalid");
  }
}

function validateSnapshot(snapshot, head, evidence) {
  const date = evidence.observedAt.slice(0, 10).replaceAll("-", "");
  const expected = { ...structuredClone(head) };
  for (const field of OVERRIDDEN_FIELDS) delete expected[field];
  const actual = { ...structuredClone(snapshot) };
  for (const field of OVERRIDDEN_FIELDS) delete actual[field];
  if (!isDeepStrictEqual(actual, expected)
    || snapshot.snapshotId !== `${SOURCE_ID}-revalidated-${date}`
    || snapshot.retrievedAt !== evidence.observedAt
    || snapshot.previousSnapshotId !== head.snapshotId
    || snapshot.coverageCount !== (head.coverageCount ?? head.rowCount)
    || snapshot.revalidationEvidenceSha256 !== evidence.evidenceSha256
    || !isDeepStrictEqual(snapshot.diffSummary, buildSnapshotDiff(head, snapshot))
    || snapshot.diffSummary?.status !== "NO_CHANGE") {
    fail("revalidated snapshot does not match the ledger head");
  }
}

export async function buildSeoulmetroStationLineInfoRegistrationOutputs({ repositoryRoot = ROOT, revalidationDirectory, now = new Date() } = {}) {
  const root = path.resolve(repositoryRoot);
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) fail("now is invalid");
  const currentBytes = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));
  const [inventory, ledger, governance, freshness] = currentBytes.map((bytes, index) => parse(bytes, OUTPUTS[index]));
  const { evidenceFile, snapshotFile } = await readRevalidationDirectory(revalidationDirectory, root);
  const evidence = parse(evidenceFile.bytes, "revalidation evidence");
  const snapshot = parse(snapshotFile.bytes, "revalidated snapshot");

  const { policySources } = validateSourceGovernancePolicy({ policy: governance, inventory, freshnessPolicy: freshness });
  const heads = validateLineage(ledger).headsBySource;
  const head = one(ledger, ({ snapshotId }) => snapshotId === heads[SOURCE_ID], "ledger head");
  if (head.sourceId !== SOURCE_ID || head.snapshotStatus !== "LOCKED" || head.licenseStatus !== "PASS"
    || head.schemaStatus !== "PASS" || head.fetchStatus !== "SUCCESS" || head.redistributionAllowed !== true
    || head.credentialRedacted !== true) fail("ledger head is not a locked licensed redacted snapshot");
  validateEvidence(evidence, head);
  validateSnapshot(snapshot, head, evidence);
  const observedAt = instant(evidence.observedAt, "observedAt");
  if (observedAt > now.getTime()) fail("observation is in the future");

  const source = one(inventory.sources, ({ id }) => id === SOURCE_ID, "inventory source");
  const policy = policySources.get(SOURCE_ID);
  const review = policy?.licenseReview;
  if (source.requiredForProductionPack !== true || source.admissionEvidence?.decision !== "APPROVED"
    || source.admissionEvidence?.rawSha256 !== head.rawSha256
    || source.license?.redistributionAllowed !== true || source.license?.commercialUseAllowed !== true
    || source.license?.derivativeWorkAllowed !== true
    || review?.status !== "APPROVED" || review.termsHash !== source.admissionEvidence?.licenseEvidenceHash
    || !(requiredUtcInstant(review.nextReviewAt, "license nextReviewAt") > now.getTime())) fail("license review is not current");

  const sourceClass = one(freshness.sourceClasses, ({ sourceIds }) => sourceIds?.includes(SOURCE_ID), "freshness class");
  if (sourceClass.id !== policy.sourceClassId) fail("freshness class binding is invalid");
  const freshnessExpiresAt = deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: sourceClass.id, basisAt: snapshot[sourceClass.basisField], evaluationAt: now.toISOString() });
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: governance, sourceId: SOURCE_ID, retrievedAt: snapshot.retrievedAt });
  if (snapshot.freshnessExpiresAt !== freshnessExpiresAt || Date.parse(freshnessExpiresAt) <= now.getTime()) fail("freshness does not match the policy or has expired");
  if (snapshot.rawRetentionExpiresAt !== rawRetentionExpiresAt || Date.parse(rawRetentionExpiresAt) <= now.getTime()) fail("raw retention does not match the policy or has expired");
  if (ledger.some(({ snapshotId }) => snapshotId === snapshot.snapshotId)) fail("snapshot already exists");

  const row = {
    ...snapshot,
    credentialRedacted: true,
    governancePolicyVersion: governance.policyVersion,
    governancePolicySha256: sha(currentBytes[2]),
  };
  const nextLedger = [...ledger, row];
  validateLineage(nextLedger);
  const nextInventory = structuredClone(inventory);
  const nextSource = nextInventory.sources.find(({ id }) => id === SOURCE_ID);
  nextSource.retrievedAt = evidence.observedAt.slice(0, 10);
  nextSource.admissionEvidence = {
    ...nextSource.admissionEvidence,
    snapshotId: row.snapshotId,
    revalidationEvidenceSha256: evidence.evidenceSha256,
    revalidationResponseSha256: evidence.responseSha256,
    revalidatedAt: evidence.observedAt,
  };
  validateSourceGovernancePolicy({ policy: governance, inventory: nextInventory, freshnessPolicy: freshness });
  const inputs = [evidenceFile, snapshotFile];
  const values = [json(nextInventory), json(nextLedger), currentBytes[2], currentBytes[3]];
  return OUTPUTS.map((relative, index) => ({ relative, bytes: values[index], prestateBytes: currentBytes[index], inputs }));
}

const transaction = createSourceRegistrationTransaction({
  label: SOURCE_ID,
  validateOutputs(outputs) {
    const inputs = outputs?.[0]?.inputs;
    if (!Array.isArray(outputs) || !isDeepStrictEqual(outputs.map(({ relative }) => relative), [...OUTPUTS])
      || !Array.isArray(inputs) || inputs.length !== 2
      || outputs.some((output) => !Buffer.isBuffer(output.bytes) || !Buffer.isBuffer(output.prestateBytes) || output.inputs !== inputs)) {
      fail("registration outputs are invalid");
    }
  },
});

export async function registerSeoulmetroStationLineInfo({
  repositoryRoot = ROOT, revalidationDirectory, expectedHeadSha, now = new Date(),
  gitRunner = async (args, settings) => (await promisify(execFile)("git", args, settings)).stdout,
} = {}) {
  const root = path.resolve(repositoryRoot);
  if (!/^[a-f0-9]{40}$/u.test(expectedHeadSha ?? "")
    || String(await gitRunner(["rev-parse", "HEAD"], { cwd: root })).trim() !== expectedHeadSha) {
    fail("execution HEAD mismatch");
  }
  await transaction.recover({ repositoryRoot: root });
  return transaction.commit({ repositoryRoot: root, outputs: await buildSeoulmetroStationLineInfoRegistrationOutputs({ repositoryRoot: root, revalidationDirectory, now }) });
}

export function parseSeoulmetroStationLineInfoRegistrationArgs(argv) {
  const names = ["revalidation-directory", "expected-head-sha"];
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith("--") ? argv[index].slice(2) : null;
    if (!names.includes(name) || Object.hasOwn(args, name) || typeof argv[index + 1] !== "string" || argv[index + 1].startsWith("--")) fail("arguments are invalid");
    args[name] = argv[index + 1];
  }
  if (names.some((name) => !Object.hasOwn(args, name))) fail("--revalidation-directory and --expected-head-sha are required");
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseSeoulmetroStationLineInfoRegistrationArgs(process.argv.slice(2));
    await registerSeoulmetroStationLineInfo({ revalidationDirectory: args["revalidation-directory"], expectedHeadSha: args["expected-head-sha"] });
    process.stdout.write(`${JSON.stringify({ sourceId: SOURCE_ID, status: "REGISTERED" })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : `${SOURCE_ID} registration failed`);
    process.exitCode = 1;
  }
}
