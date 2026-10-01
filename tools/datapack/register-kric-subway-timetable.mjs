#!/usr/bin/env node
// #862 결정 3b: kric-subway-timetable(4호선 상록수–사당 pilot) 원장 등록기.
// 공식 수집기(collect-kric-line4-timetables.mjs) 산출물, 공식 게시기(publish-kric-timetable-raw.mjs) receipt,
// QA 검토 admission을 받아 원장 행과 inventory admission evidence를 등록한다.
// 결정 C: 후보 spec·release request·hash evidence는 쓰지 않는다. 검토 admission은 이 도구가 만들지 않는다.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { validateKricLine4PilotCollectionArtifact } from "./apply-kric-line4-pilot-schedule.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { createSourceRegistrationTransaction, SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_ID = "kric-subway-timetable";
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const OCI_NAMESPACE = "axvym6vk8g7i";
const OCI_BUCKET = "easysubway-datapacks";
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "collectedAt", "rawObjectUri",
  "rawObjectSha256", "ociNamespace", "bucket", "objectKey", "capturedDate", "byteSize", "storedAt", "rawRetentionExpiresAt",
]);
const REVIEW_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "rawSha256", "byteSize", "decision", "approvedBy", "approvedAt",
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = (message) => { throw new Error(`${SOURCE_ID} registration: ${message}`); };

function parse(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { return fail(`${label} is invalid JSON`); }
}
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}
function instant(value) {
  try { return requiredUtcInstant(value, "instant"); } catch { return Number.NaN; }
}
function one(items, predicate, label) {
  const matches = Array.isArray(items) ? items.filter(predicate) : [];
  if (matches.length !== 1) fail(`${label} is missing or ambiguous`);
  return matches[0];
}
async function externalFile(file, label, repositoryRoot) {
  if (!path.isAbsolute(file ?? "")) fail(`${label} path must be absolute`);
  const resolved = path.resolve(file);
  if (resolved.startsWith(`${repositoryRoot}${path.sep}`)) fail(`${label} must be outside the repository`);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  return { absolute: resolved, bytes: await readFile(resolved) };
}

// 수집 산출물의 원본 응답 행 필드 합집합(정렬)으로 스키마 지문을 만든다.
function providerSchemaFingerprint(artifact) {
  const fields = new Set();
  for (const response of artifact.rawResponseInventory.responses) {
    const body = parse(Buffer.from(response.bodyBase64, "base64"), "KRIC raw response");
    for (const row of Array.isArray(body?.body) ? body.body : []) for (const key of Object.keys(row)) fields.add(key);
  }
  if (fields.size === 0) fail("KRIC raw responses have no provider rows");
  return sha(JSON.stringify([...fields].sort()));
}

function validateReceipt(receipt, artifact, bytes, governance, now) {
  const rawSha256 = sha(bytes);
  const date = artifact.capturedAt.replaceAll("-", "");
  const objectKey = `source-raw/${SOURCE_ID}/${date}/${rawSha256}.json`;
  const storedAt = instant(receipt?.storedAt);
  if (!exactKeys(receipt, RECEIPT_KEYS) || receipt.schemaVersion !== 1 || receipt.artifactKind !== "kric-timetable-raw-object-receipt"
    || receipt.sourceId !== SOURCE_ID || receipt.snapshotId !== `${SOURCE_ID}-line4-pilot-${date}`
    || receipt.capturedAt !== artifact.capturedAt || receipt.collectedAt !== artifact.collectedAt
    || receipt.rawObjectSha256 !== rawSha256 || receipt.byteSize !== bytes.length
    || receipt.ociNamespace !== OCI_NAMESPACE || receipt.bucket !== OCI_BUCKET || receipt.objectKey !== objectKey
    || receipt.capturedDate !== date || receipt.rawObjectUri !== `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${objectKey}`
    || !(storedAt >= instant(artifact.collectedAt)) || !(storedAt <= now.getTime())
    || receipt.rawRetentionExpiresAt !== deriveRawRetentionExpiresAt({ policy: governance, sourceId: SOURCE_ID, retrievedAt: artifact.collectedAt })
    || !(instant(receipt.rawRetentionExpiresAt) > now.getTime())) {
    fail("raw receipt is invalid");
  }
}

function validateReview(review, receipt, artifact, now) {
  const approvedAt = instant(review?.approvedAt);
  if (!exactKeys(review, REVIEW_KEYS) || review.schemaVersion !== 1 || review.artifactKind !== "kric-subway-timetable-review-admission"
    || review.sourceId !== SOURCE_ID || review.snapshotId !== receipt.snapshotId
    || review.rawSha256 !== receipt.rawObjectSha256 || review.byteSize !== receipt.byteSize
    || review.decision !== "APPROVED" || typeof review.approvedBy !== "string" || review.approvedBy.trim() === ""
    || !(approvedAt >= instant(artifact.collectedAt)) || !(approvedAt <= now.getTime())) {
    fail("review admission is invalid");
  }
}

export async function buildKricSubwayTimetableRegistrationOutputs({
  repositoryRoot = ROOT, collectionPath, receiptPath, reviewAdmissionPath, now = new Date(),
} = {}) {
  const root = path.resolve(repositoryRoot);
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) fail("now is invalid");
  const currentBytes = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));
  const [inventory, ledger, governance, freshness] = currentBytes.map((bytes, index) => parse(bytes, OUTPUTS[index]));
  const collectionFile = await externalFile(collectionPath, "collection", root);
  const receiptFile = await externalFile(receiptPath, "raw receipt", root);
  const reviewFile = await externalFile(reviewAdmissionPath, "review admission", root);
  const artifact = parse(collectionFile.bytes, "collection");
  validateKricLine4PilotCollectionArtifact(artifact);
  const receipt = parse(receiptFile.bytes, "raw receipt");
  validateReceipt(receipt, artifact, collectionFile.bytes, governance, now);
  const review = parse(reviewFile.bytes, "review admission");
  validateReview(review, receipt, artifact, now);

  const { policySources } = validateSourceGovernancePolicy({ policy: governance, inventory, freshnessPolicy: freshness });
  const heads = validateLineage(ledger).headsBySource;
  const head = one(ledger, ({ snapshotId }) => snapshotId === heads[SOURCE_ID], "ledger head");
  if (head.snapshotStatus !== "LOCKED" || head.licenseStatus !== "PASS" || head.credentialRedacted !== true) {
    fail("ledger head is not a locked licensed redacted snapshot");
  }
  if (ledger.some(({ snapshotId }) => snapshotId === receipt.snapshotId)) fail("snapshot already exists");
  const source = one(inventory.sources, ({ id }) => id === SOURCE_ID, "inventory source");
  const policy = policySources.get(SOURCE_ID);
  const reviewRecord = policy?.licenseReview;
  if (source.requiredForProductionPack !== true || source.capabilities?.schedule?.productionUseAllowed !== true
    || source.license?.redistributionAllowed !== true || source.license?.commercialUseAllowed !== true
    || source.license?.derivativeWorkAllowed !== true
    || reviewRecord?.status !== "APPROVED" || reviewRecord.termsHash !== source.admissionEvidence?.licenseEvidenceHash
    || !(instant(reviewRecord.nextReviewAt) > now.getTime())) {
    fail("license review is not current");
  }
  const sourceClass = one(freshness.sourceClasses, ({ sourceIds }) => sourceIds?.includes(SOURCE_ID), "freshness class");
  if (sourceClass.id !== policy.sourceClassId || sourceClass.basisField !== "serviceEffectiveAt") fail("freshness class binding is invalid");
  // 수집기는 제공처 유효 종료일을 받지 않는다. 신선도는 수집 시각 + 정책 주기다(추정 종료일을 넣지 않는다).
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: freshness, sourceClassId: sourceClass.id, basisAt: artifact.collectedAt, evaluationAt: now.toISOString(),
  });
  if (!(instant(freshnessExpiresAt) > now.getTime())) fail("freshness has expired");

  const row = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    snapshotId: receipt.snapshotId,
    sourceId: SOURCE_ID,
    provider: head.provider,
    retrievedAt: artifact.collectedAt,
    sourceUpdatedAt: artifact.collectedAt,
    serviceEffectiveAt: artifact.collectedAt,
    rowCount: artifact.transitTripCount,
    coverageCount: 1,
    rawSha256: receipt.rawObjectSha256,
    rawObjectUri: receipt.rawObjectUri,
    redactedRequestFingerprint: artifact.rawResponseInventory.inventorySha256,
    schemaFingerprint: providerSchemaFingerprint(artifact),
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    previousSnapshotId: head.snapshotId,
    diffSummary: null,
    freshnessExpiresAt,
    rawRetentionExpiresAt: receipt.rawRetentionExpiresAt,
    rawReceipt: receipt,
    governancePolicyVersion: governance.policyVersion,
    governancePolicySha256: sha(currentBytes[2]),
  };
  row.diffSummary = buildSnapshotDiff(head, row);
  const nextLedger = [...ledger, row];
  validateLineage(nextLedger);
  const nextInventory = structuredClone(inventory);
  const nextSource = nextInventory.sources.find(({ id }) => id === SOURCE_ID);
  nextSource.retrievedAt = artifact.capturedAt;
  nextSource.observedDataUpdatedAt = artifact.capturedAt;
  nextSource.admissionEvidence = {
    ...nextSource.admissionEvidence,
    snapshotId: row.snapshotId,
    decision: review.decision,
    approvedBy: review.approvedBy,
    approvedAt: review.approvedAt,
    rawSha256: row.rawSha256,
    schemaFingerprint: row.schemaFingerprint,
    adminReviewRecordHash: sha(reviewFile.bytes),
  };
  validateSourceGovernancePolicy({ policy: governance, inventory: nextInventory, freshnessPolicy: freshness });
  const inputs = [collectionFile, receiptFile, reviewFile];
  const values = [json(nextInventory), json(nextLedger), currentBytes[2], currentBytes[3]];
  return OUTPUTS.map((relative, index) => ({ relative, bytes: values[index], prestateBytes: currentBytes[index], inputs }));
}

const transaction = createSourceRegistrationTransaction({
  label: SOURCE_ID,
  validateOutputs(outputs) {
    const inputs = outputs?.[0]?.inputs;
    if (!Array.isArray(outputs) || !isDeepStrictEqual(outputs.map(({ relative }) => relative), [...OUTPUTS])
      || !Array.isArray(inputs) || inputs.length !== 3
      || outputs.some((output) => !Buffer.isBuffer(output.bytes) || !Buffer.isBuffer(output.prestateBytes) || output.inputs !== inputs)) {
      fail("registration outputs are invalid");
    }
  },
});

export async function registerKricSubwayTimetable({
  repositoryRoot = ROOT, collectionPath, receiptPath, reviewAdmissionPath, expectedHeadSha, now = new Date(),
  gitRunner = async (args, settings) => (await promisify(execFile)("git", args, settings)).stdout,
} = {}) {
  const root = path.resolve(repositoryRoot);
  if (!/^[a-f0-9]{40}$/u.test(expectedHeadSha ?? "")
    || String(await gitRunner(["rev-parse", "HEAD"], { cwd: root })).trim() !== expectedHeadSha) {
    fail("execution HEAD mismatch");
  }
  await transaction.recover({ repositoryRoot: root });
  return transaction.commit({
    repositoryRoot: root,
    outputs: await buildKricSubwayTimetableRegistrationOutputs({ repositoryRoot: root, collectionPath, receiptPath, reviewAdmissionPath, now }),
  });
}

export function parseKricSubwayTimetableRegistrationArgs(argv) {
  const names = ["collection", "receipt", "review-admission", "expected-head-sha"];
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith("--") ? argv[index].slice(2) : null;
    if (!names.includes(name) || Object.hasOwn(args, name) || typeof argv[index + 1] !== "string" || argv[index + 1].startsWith("--")) fail("arguments are invalid");
    args[name] = argv[index + 1];
  }
  if (names.some((name) => !Object.hasOwn(args, name))) fail("--collection, --receipt, --review-admission and --expected-head-sha are required");
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseKricSubwayTimetableRegistrationArgs(process.argv.slice(2));
    await registerKricSubwayTimetable({
      collectionPath: args.collection, receiptPath: args.receipt, reviewAdmissionPath: args["review-admission"], expectedHeadSha: args["expected-head-sha"],
    });
    process.stdout.write(`${JSON.stringify({ sourceId: SOURCE_ID, status: "REGISTERED" })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : `${SOURCE_ID} registration failed`);
    process.exitCode = 1;
  }
}
