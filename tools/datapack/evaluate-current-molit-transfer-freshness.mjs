#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { molitRailwayTransferMovementEditionFromSnapshotId } from "./collect-molit-railway-transfer-movement.mjs";

import { evaluateFreshnessExtension, freshnessPolicySha256 } from "./freshness-policy.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const SOURCE_ID = "molit-railway-transfer-movement";
const SOURCE_CLASS_ID = "annual_official_file";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
// #862: 판(snapshotId·경로·operationId)은 상수가 아니라 metadata의 snapshotId에서 유도한다.
const metadataPathOf = (snapshotId) => `tools/datapack/sources/${snapshotId}.csv.gz.json`;
const editionOf = (snapshotId) => {
  try {
    return molitRailwayTransferMovementEditionFromSnapshotId(snapshotId);
  } catch {
    return fail("SOURCE_IDENTITY");
  }
};
const POLICY_PATH = "release/product-gates/datapack-freshness-sla.json";
const DETAIL_PAGE_URL = "https://www.data.go.kr/data/15130556/fileData.do";
const MAX_EVIDENCE_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const EVIDENCE_KEYS = [
  "schemaVersion", "artifactKind", "contractVersion", "sourceId", "snapshotId", "observedAt",
  "operation", "lockedSnapshot", "providerObservation", "outcome", "credentialRedacted", "evidenceHash",
];
const OPERATION_KEYS = ["method", "operationId", "detailPageUrl"];
const LOCKED_SNAPSHOT_KEYS = [
  "metadataPath", "metadataFileSha256", "rawSha256", "gzipSha256", "sortedContentSha256", "rowCount",
];
const PROVIDER_OBSERVATION_KEYS = [
  "rawSha256", "byteSize", "canonicalRowsSha256", "totalCount",
];

function fail(code) {
  throw new Error(`MOLIT_TRANSFER_FRESHNESS_${code}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function parseEvaluationAt(value) {
  try {
    const millis = requiredUtcInstant(value, "evaluationAt");
    if (new Date(millis).toISOString() !== value) fail("ARGUMENT");
    return value;
  } catch (error) {
    if (/^MOLIT_TRANSFER_FRESHNESS_/u.test(error?.message ?? "")) throw error;
    fail("ARGUMENT");
  }
}

function validatePolicy(policy) {
  const matches = Array.isArray(policy?.sourceClasses)
    ? policy.sourceClasses.filter(({ id }) => id === SOURCE_CLASS_ID)
    : [];
  const sourceClass = matches.length === 1 ? matches[0] : null;
  if (policy?.schemaVersion !== 2
    || sourceClass?.basisField !== "observedAt"
    || sourceClass.reverificationCadence !== "P1Y"
    || sourceClass.offlinePackEligible !== true
    // #876: 서울교통공사 실측 환승시간 원천(15098252)이 같은 연간 공식 파일 클래스로 등록됐다. 구성은 여전히 정확히 고정한다.
    || JSON.stringify(sourceClass.sourceIds) !== JSON.stringify([SOURCE_ID, "seoul-metro-transfer-distance-duration", "seoul-metro-transfer-car-door-duration"])) {
    fail("POLICY");
  }
}

function molitCompatibilityPolicy(policy) {
  return {
    ...policy,
    sourceClasses: policy.sourceClasses.map((sourceClass) => sourceClass.id === SOURCE_CLASS_ID
      ? { ...sourceClass, sourceIds: [SOURCE_ID] }
      : sourceClass),
  };
}

function validateMetadata(metadata, metadataBytes, gzipBytes) {
  if (!Buffer.isBuffer(metadataBytes) || !Buffer.isBuffer(gzipBytes)
    || metadata?.schemaVersion !== 1
    || metadata.artifactKind !== "molit-railway-transfer-movement-snapshot-metadata"
    || metadata.sourceId !== SOURCE_ID
    || typeof metadata.snapshotId !== "string"
    || editionOf(metadata.snapshotId) === ""
    || metadata.detailUrl !== DETAIL_PAGE_URL
    || !SHA256_PATTERN.test(metadata.rawSha256 ?? "")
    || !SHA256_PATTERN.test(metadata.gzipSha256 ?? "")
    || !SHA256_PATTERN.test(metadata.sortedContentSha256 ?? "")
    || metadata.gzipSha256 !== sha256(gzipBytes)
    || !Number.isSafeInteger(metadata.rowCount)
    || metadata.rowCount < 1) {
    fail("SOURCE_IDENTITY");
  }
  parseEvaluationAt(metadata.freshUntil);
}

function validateEvidence(evidence, metadata, metadataBytes, rawByteSize) {
  if (!exactKeys(evidence, EVIDENCE_KEYS)) fail("EVIDENCE");
  const { evidenceHash, ...payload } = evidence;
  if (!SHA256_PATTERN.test(evidenceHash ?? "") || evidenceHash !== sha256(JSON.stringify(payload))) {
    fail("EVIDENCE");
  }
  if (evidence.schemaVersion !== 1
    || evidence.artifactKind !== "current-molit-transfer-source-revalidation-evidence"
    || evidence.contractVersion !== "1.0.0"
    || evidence.sourceId !== SOURCE_ID
    || evidence.snapshotId !== metadata.snapshotId
    || evidence.outcome !== "NO_CHANGE_REVALIDATED"
    || evidence.credentialRedacted !== true
    || !exactKeys(evidence.operation, OPERATION_KEYS)
    || evidence.operation.method !== "FILE_DOWNLOAD"
    || evidence.operation.operationId !== `15130556-fileData-${editionOf(metadata.snapshotId)}`
    || evidence.operation.detailPageUrl !== DETAIL_PAGE_URL
    || !exactKeys(evidence.lockedSnapshot, LOCKED_SNAPSHOT_KEYS)
    || evidence.lockedSnapshot.metadataPath !== metadataPathOf(metadata.snapshotId)
    || evidence.lockedSnapshot.metadataFileSha256 !== sha256(metadataBytes)
    || evidence.lockedSnapshot.rawSha256 !== metadata.rawSha256
    || evidence.lockedSnapshot.gzipSha256 !== metadata.gzipSha256
    || evidence.lockedSnapshot.sortedContentSha256 !== metadata.sortedContentSha256
    || evidence.lockedSnapshot.rowCount !== metadata.rowCount
    || !exactKeys(evidence.providerObservation, PROVIDER_OBSERVATION_KEYS)
    || evidence.providerObservation.rawSha256 !== metadata.rawSha256
    || evidence.providerObservation.byteSize !== rawByteSize
    || evidence.providerObservation.canonicalRowsSha256 !== metadata.sortedContentSha256
    || evidence.providerObservation.totalCount !== metadata.rowCount) {
    fail("EVIDENCE");
  }
  parseEvaluationAt(evidence.observedAt);
}

export function evaluateCurrentMolitTransferFreshness({
  evidence,
  evaluationAt,
  gzipBytes,
  metadata,
  metadataBytes,
  now = Date.now(),
  policy,
} = {}) {
  validatePolicy(policy);
  const compatibilityPolicy = molitCompatibilityPolicy(policy);
  validateMetadata(metadata, metadataBytes, gzipBytes);
  validateEvidence(evidence, metadata, metadataBytes, gunzipSync(gzipBytes).length);
  parseEvaluationAt(evaluationAt);

  const sourceIdentity = {
    sourceId: SOURCE_ID,
    snapshotId: metadata.snapshotId,
    snapshotSha256: metadata.gzipSha256,
    rawEvidenceSha256: metadata.rawSha256,
    currentFreshUntil: metadata.freshUntil,
  };
  const input = {
    schemaVersion: 1,
    artifactKind: "source-freshness-extension-input",
    evaluationAt,
    sourceIdentity,
    policyBinding: {
      sourceClassId: SOURCE_CLASS_ID,
      policySha256: freshnessPolicySha256(compatibilityPolicy),
    },
    observation: {
      schemaVersion: 1,
      artifactKind: "source-freshness-observation",
      outcome: "POSITIVE",
      sourceId: sourceIdentity.sourceId,
      snapshotId: sourceIdentity.snapshotId,
      snapshotSha256: sourceIdentity.snapshotSha256,
      rawEvidenceSha256: sourceIdentity.rawEvidenceSha256,
      observedAt: evidence.observedAt,
      evidenceSha256: evidence.evidenceHash,
      providerValidUntil: null,
      sourceValidUntil: null,
      licenseValidUntil: null,
    },
  };
  const result = evaluateFreshnessExtension({ input, policy: compatibilityPolicy, now });
  if (result.decision !== "EXTENDED" || result.reasonCode !== "POSITIVE_OBSERVATION_EXTENDED") {
    fail("INELIGIBLE");
  }
  return result;
}

function parseArgs(argv) {
  const allowed = new Set(["evaluation-at", "output", "revalidation-evidence"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    const key = option?.startsWith("--") ? option.slice(2) : "";
    if (!allowed.has(key) || typeof value !== "string" || value === "" || Object.hasOwn(args, key)) {
      fail("ARGUMENT");
    }
    args[key] = value;
  }
  if (Object.keys(args).length !== 3
    || !path.isAbsolute(args["revalidation-evidence"])
    || !path.isAbsolute(args.output)) {
    fail("ARGUMENT");
  }
  return {
    evaluationAt: parseEvaluationAt(args["evaluation-at"]),
    evidencePath: path.resolve(args["revalidation-evidence"]),
    output: path.resolve(args.output),
  };
}

async function readBoundedRegularFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_EVIDENCE_BYTES) fail("FILE");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || offset !== before.size) fail("FILE");
    return bytes;
  } catch (error) {
    if (/^MOLIT_TRANSFER_FRESHNESS_/u.test(error?.message ?? "")) throw error;
    fail("FILE");
  } finally {
    try { await handle?.close(); } catch {}
  }
}

async function assertAbsentOutput(output) {
  try {
    await lstat(output);
    fail("OUTPUT");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    const parent = await lstat(path.dirname(output));
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail("OUTPUT");
  } catch (error) {
    if (/^MOLIT_TRANSFER_FRESHNESS_/u.test(error?.message ?? "")) throw error;
    fail("OUTPUT");
  }
}

function sameOwnedFile(file, identity) {
  return file.isFile()
    && !file.isSymbolicLink()
    && file.dev === identity.dev
    && file.ino === identity.ino
    && file.size === identity.size
    && (file.mode & 0o777) === 0o600;
}

async function removeOwnedFile(filePath, identity) {
  try {
    const current = await lstat(filePath);
    if (sameOwnedFile(current, identity)) await unlink(filePath);
  } catch {}
}

async function publishResult(output, result, fixture) {
  const temporary = `${output}.tmp-${randomUUID()}`;
  let handle;
  let identity;
  let linked = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    identity = await handle.stat();
    if (!identity.isFile() || (identity.mode & 0o777) !== 0o600 || identity.size !== bytes.length) fail("OUTPUT");
    await handle.close();
    handle = undefined;
    await link(temporary, output);
    linked = true;
    await fixture.afterLink?.({ output, temporary });
    const published = await lstat(output);
    if (!sameOwnedFile(published, identity)) fail("OUTPUT");
    await removeOwnedFile(temporary, identity);
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (identity) {
      if (linked) await removeOwnedFile(output, identity);
      await removeOwnedFile(temporary, identity);
    }
    if (/^MOLIT_TRANSFER_FRESHNESS_/u.test(error?.message ?? "")) throw error;
    fail("OUTPUT");
  }
}

export async function runCurrentMolitTransferFreshnessEvaluation({
  argv = process.argv.slice(2),
  now = Date.now(),
  publishFixture = {},
  repositoryRoot = path.resolve(import.meta.dirname, "../.."),
} = {}) {
  const args = parseArgs(argv);
  await assertAbsentOutput(args.output);
  let admission;
  try {
    admission = JSON.parse(await readFile(path.join(repositoryRoot, INVENTORY_PATH), "utf8")).sources
      .filter(({ id }) => id === SOURCE_ID).map(({ rawSnapshotAdmission }) => rawSnapshotAdmission);
  } catch {
    fail("SOURCE_IDENTITY");
  }
  if (admission.length !== 1 || admission[0]?.metadataPath !== metadataPathOf(admission[0]?.snapshotId)) fail("SOURCE_IDENTITY");
  const [evidenceBytes, metadataBytes, gzipBytes, policyBytes] = await Promise.all([
    readBoundedRegularFile(args.evidencePath),
    readFile(path.join(repositoryRoot, admission[0].metadataPath)),
    readFile(path.join(repositoryRoot, admission[0].metadataPath.replace(/\.json$/u, ""))),
    readFile(path.join(repositoryRoot, POLICY_PATH)),
  ]);
  let evidence;
  let metadata;
  let policy;
  try {
    evidence = JSON.parse(evidenceBytes);
    metadata = JSON.parse(metadataBytes);
    policy = JSON.parse(policyBytes);
  } catch {
    fail("EVIDENCE");
  }
  if (metadata?.snapshotId !== admission[0].snapshotId || sha256(metadataBytes) !== admission[0].metadataFileSha256) fail("SOURCE_IDENTITY");
  const result = evaluateCurrentMolitTransferFreshness({
    evidence,
    evaluationAt: args.evaluationAt,
    gzipBytes,
    metadata,
    metadataBytes,
    now,
    policy,
  });
  await publishResult(args.output, result, publishFixture);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCurrentMolitTransferFreshnessEvaluation()
    .then((result) => process.stdout.write(`${JSON.stringify({
      decision: result.decision,
      reasonCode: result.reasonCode,
      resultSha256: result.resultSha256,
    })}\n`))
    .catch((error) => {
      const match = /^MOLIT_TRANSFER_FRESHNESS_[A-Z_]+$/u.exec(error?.message ?? "");
      process.stderr.write(`${match?.[0] ?? "MOLIT_TRANSFER_FRESHNESS_FAILED"}\n`);
      process.exitCode = 1;
    });
}
