#!/usr/bin/env node
// 서울교통공사 환승 거리·시간 증거를 현재 수도권 정본 팩에 다시 결속한다(#866, #862 결정 C).
//
// 일일 갱신의 activate 단계는 수도권 정본 팩을 다시 쓴다(인천 station-info P1D, KRIC FACILITY 결속 등).
// 환승 지표·applicability·descriptor·inventory transferAdmissionEvidence·원장 transferTopology는 정본 팩 sha에
// 묶여 있으므로, 원천을 다시 수집하지 않고 원장에 잠긴 raw만으로 이 결속을 새 팩에 맞춘다.
//
// 사용(전국 후보 갱신 전에, 브랜치 무관):
//   node --env-file=<루트 .env> tools/datapack/rebind-current-seoul-transfer-source-admission.mjs --repository-root <absolute>
//
// - OCI는 원장 receipt의 objectKey 하나를 PAR로 GET만 한다(PUT 없음). 바이트 수·sha256이 원장과 다르면 실패한다.
// - 원천 값(지표 행·쌍·분모·개수·descriptor 본문)이 하나라도 바뀌면 쓰지 않고 실패한다. 바뀌는 것은 입력 결속
//   hash뿐이다: 정본 팩 sha, 원천 후보 계약(source-candidates.json)·KRIC 노선 catalog 파일 sha, 이들로부터 유도한
//   지표·applicability artifact sha, descriptor 파일 sha. 원천 후보 계약 안의 환승 endpoint는 receipt의 manifest sha로
//   고정되므로(reconstruct 검사) 계약 파일 sha가 바뀌어도 환승 관측은 같다.
// - 출력은 환승 원천 admission 5개 경로뿐이다. 후보 spec·release request·hash evidence는 이어서
//   refresh-nationwide-candidate가 다시 만든다.
// - 대체값·이전 값·추정치로 실패를 덮지 않는다.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import { rebuildAuthenticatedTransferTopologyMetrics } from "./build-current-transfer-topology-metrics.mjs";
import {
  collectCurrentSeoulTransferDistanceDurationSnapshot,
  readSeoulTransferObservationDirectory,
  reconstructSeoulTransferObservationFromRawSnapshot,
} from "./collect-current-seoul-transfer-distance-duration-snapshot.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { preauthenticatedObjectStorageClient, requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";
import { publishSeoulTransferRawArtifact, validateSeoulTransferRawReceipt } from "./publish-seoul-transfer-raw.mjs";
import { registerSeoulTransferSourceSnapshot } from "./register-seoul-transfer-source-snapshot.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { sha256 } from "../lib/hash.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_ID = "seoul-metro-transfer-distance-duration";
const RETENTION_REFRESH_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
const PATHS = Object.freeze({
  canonicalPack: "tools/datapack/release/capital-production-canonical-pack.json",
  metrics: "tools/datapack/release/current-transfer-topology-metrics.json",
  applicability: "tools/datapack/release/current-capital-transfer-topology-applicability.json",
  inventory: "tools/datapack/source-inventory.json",
  ledger: "tools/datapack/release/source-snapshots.json",
  sourceCandidates: "tools/datapack/source-candidates.json",
  kricCatalog: "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
  governancePolicy: "tools/datapack/source-governance-policy.json",
  freshnessPolicy: "release/product-gates/datapack-freshness-sla.json",
});
const DESCRIPTOR_PATH = /^tools\/datapack\/sources\/seoul-metro-transfer-distance-duration-[0-9]{8}T[0-9]{9}Z\.json$/u;
const TOPOLOGY_BINDING_KEYS = Object.freeze(["canonicalPackSha256", "metricsArtifactSha256", "applicabilityArtifactSha256"]);
const INPUT_CONTRACT_BINDING_KEYS = Object.freeze(["sourceCandidateSha256", "kricProviderCatalogSha256"]);
const REFRESH_OBSERVATION_KEYS = Object.freeze(["capturedAt", "manifestSha256", "observationSha256", "rawSnapshotSha256", "rawSha256"]);
const lineBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const prettyBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function SEOUL_TRANSFER_REBIND_OUTPUTS(descriptorPath) {
  if (typeof descriptorPath !== "string" || !DESCRIPTOR_PATH.test(descriptorPath)) throw new Error("TRANSFER descriptor path mismatch");
  return Object.freeze([PATHS.metrics, PATHS.applicability, descriptorPath, PATHS.inventory, PATHS.ledger]);
}

function requiredAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}

async function stableBytes(file, label) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { throw new Error(`${label} must be a readable regular file`, { cause: error }); }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error(`${label} changed during read`);
    return bytes;
  } finally { await handle.close(); }
}

function parse(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${label} must be strict UTF-8 JSON`); }
}

// 원장에서 잠긴(LOCKED·SUCCESS) 환승 단일 계보의 최신 head 행을 찾고 receipt·raw sha·URI를 검증한다.
export function activeLockedSeoulTransferRow(ledger) {
  if (!Array.isArray(ledger)) throw new Error("TRANSFER source ledger must be an array");
  const rows = ledger.filter((entry) => entry?.sourceId === SOURCE_ID && entry.snapshotStatus === "LOCKED" && entry.fetchStatus === "SUCCESS");
  if (rows.length === 0) throw new Error("TRANSFER source ledger must contain one active locked row");
  const bySnapshotId = new Map();
  for (const entry of rows) {
    if (typeof entry.snapshotId !== "string" || entry.snapshotId === "" || bySnapshotId.has(entry.snapshotId)) {
      throw new Error("TRANSFER source ledger must contain one active locked row");
    }
    bySnapshotId.set(entry.snapshotId, entry);
  }
  const referenced = new Set();
  for (const entry of rows) {
    const prev = entry.previousSnapshotId ?? null;
    if (prev !== null) {
      if (!bySnapshotId.has(prev) || referenced.has(prev)) {
        throw new Error("TRANSFER source ledger must contain one active locked row");
      }
      referenced.add(prev);
    }
  }
  const heads = rows.filter((entry) => !referenced.has(entry.snapshotId));
  if (heads.length !== 1) throw new Error("TRANSFER source ledger must contain one active locked row");
  const [row] = heads;
  const receipt = validateSeoulTransferRawReceipt(row.rawReceipt);
  if (row.snapshotId !== receipt.snapshotId || row.rawSha256 !== receipt.snapshotRawSha256 || row.rawSha256 !== receipt.rawObjectSha256
    || row.rawObjectUri !== receipt.rawObjectUri || row.rowCount !== 145 || typeof row.contentSha256 !== "string" || typeof row.schemaFingerprint !== "string"
    || !row.transferTopology || typeof row.transferTopology !== "object") {
    throw new Error("TRANSFER ledger receipt identity mismatch");
  }
  return { row, receipt };
}

function assertAdmissionIdentity({ inventory, row, descriptor, descriptorBytes, descriptorPath, metrics, applicability }) {
  const sources = inventory?.sources?.filter(({ id }) => id === SOURCE_ID) ?? [];
  const admission = sources[0]?.transferAdmissionEvidence;
  if (sources.length !== 1 || sources[0].requiredForProductionPack !== true || !admission
    || admission.snapshotId !== row.snapshotId || admission.snapshotPath !== descriptorPath || admission.snapshotFileSha256 !== sha256(descriptorBytes)
    || admission.rawSha256 !== row.rawSha256 || admission.contentSha256 !== row.contentSha256 || admission.schemaFingerprint !== row.schemaFingerprint
    || admission.metricsArtifactSha256 !== metrics.artifactSha256 || admission.applicabilityArtifactSha256 !== applicability.artifactSha256
    || descriptor?.sourceId !== SOURCE_ID || descriptor.snapshotId !== row.snapshotId || descriptor.rawSha256 !== row.rawSha256
    || descriptor.contentSha256 !== row.contentSha256 || descriptor.schemaFingerprint !== row.schemaFingerprint
    || !isDeepStrictEqual(descriptor.transferTopology, row.transferTopology)
    || descriptor.transferTopology?.metricsArtifactSha256 !== metrics.artifactSha256
    || descriptor.transferTopology?.applicabilityArtifactSha256 !== applicability.artifactSha256
    || metrics.sourceIdentity?.rawSha256 !== row.rawSha256 || metrics.sourceIdentity?.contentSha256 !== row.contentSha256) {
    throw new Error("TRANSFER admission identity mismatch");
  }
  return admission;
}

// 입력 결속 hash를 지운 뒤 앞뒤가 같아야 한다. 같지 않으면 원천 값이 바뀐 것이므로 실패한다.
function assertOnlyBindingChanged(previous, next, erase, label) {
  const strip = (value) => { const copy = structuredClone(value); erase(copy); return copy; };
  if (!isDeepStrictEqual(strip(previous), strip(next))) throw new Error(`${label} changed under canonical pack re-binding`);
}
const eraseKeys = (value, keys) => { for (const key of keys) delete value?.[key]; };
const eraseMetricsBinding = (value) => {
  delete value.artifactSha256; delete value.canonicalIdentity.canonicalPackSha256; eraseKeys(value.sourceIdentity, INPUT_CONTRACT_BINDING_KEYS);
};
const eraseApplicabilityBinding = (value) => { eraseMetricsBinding(value); delete value.transferTopologyMetricsIdentity.artifactSha256; };
const eraseDescriptorBinding = (value) => {
  delete value.snapshotSha256; eraseKeys(value.transferTopology, TOPOLOGY_BINDING_KEYS); eraseKeys(value.observationIdentity, INPUT_CONTRACT_BINDING_KEYS);
};
const eraseRefreshMetricsBinding = (value) => {
  eraseMetricsBinding(value); eraseKeys(value.sourceIdentity, REFRESH_OBSERVATION_KEYS);
};
const eraseRefreshApplicabilityBinding = (value) => {
  eraseApplicabilityBinding(value); eraseKeys(value.sourceIdentity, REFRESH_OBSERVATION_KEYS);
};
const eraseRefreshDescriptorBinding = (value) => {
  eraseDescriptorBinding(value);
  eraseKeys(value, ["snapshotId", "capturedAt", "observedAt", "freshUntil", "rawSha256"]);
  eraseKeys(value.observationIdentity, ["manifestSha256", "observationSha256", "rawSnapshotSha256"]);
};

// PAR URL은 토큰이 곧 접근 권한이다. 오류 메시지에서 base URL과 토큰을 원문·디코딩·URL 인코딩 형태 모두 지운다.
function redactPar(message, parBaseUrl) {
  const token = parBaseUrl.pathname.split("/")[2] ?? "";
  let decoded = token;
  try { decoded = decodeURIComponent(token); } catch { /* 디코딩할 수 없는 토큰은 원문만 지운다 */ }
  const secrets = [...new Set([parBaseUrl.href, token, decoded].flatMap((value) => [value, encodeURIComponent(value)]))]
    .filter((value) => value !== "")
    .sort((left, right) => right.length - left.length);
  let redacted = message;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[redacted]");
  return redacted.replaceAll(/\/p\/[^/\s]+/gu, "/p/[redacted]");
}

async function readLockedRaw({ client, receipt, parBaseUrl }) {
  let fetched;
  try {
    fetched = await client.readObject(receipt.objectKey, { maxResponseBytes: receipt.byteSize });
  } catch (error) {
    throw new Error(`locked TRANSFER raw GET failed: ${redactPar(String(error?.message ?? "request failed"), parBaseUrl)}`);
  }
  if (!fetched?.exists) throw new Error("locked TRANSFER raw object is missing");
  // 바이트 수 상한은 GET의 maxResponseBytes(receipt byteSize)가 지키고, 잘리거나 덧붙은 본문은 sha256 대조가 막는다.
  if (!Buffer.isBuffer(fetched.body) || sha256(fetched.body) !== receipt.rawObjectSha256) {
    throw new Error("locked TRANSFER raw bytes mismatch");
  }
  return fetched.body;
}

export async function deriveCurrentSeoulTransferSourceAdmissionOutputs({
  repositoryRoot = ROOT,
  env = process.env,
  now = new Date(),
  client = null,
  refreshRetentionIfNeeded = false,
  operationRoot = null,
  collectSnapshot = collectCurrentSeoulTransferDistanceDurationSnapshot,
  publishRaw = publishSeoulTransferRawArtifact,
} = {}) {
  const root = requiredAbsolute(repositoryRoot, "repository root");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("re-binding time must be valid");
  const read = (relative) => stableBytes(path.join(root, relative), relative);
  const [packBytes, metricsBytes, applicabilityBytes, inventoryBytes, ledgerBytes, sourceCandidatesBytes, kricBytes] = await Promise.all([
    read(PATHS.canonicalPack), read(PATHS.metrics), read(PATHS.applicability), read(PATHS.inventory), read(PATHS.ledger),
    read(PATHS.sourceCandidates), read(PATHS.kricCatalog),
  ]);
  const ledger = parse(ledgerBytes, PATHS.ledger);
  const inventory = parse(inventoryBytes, PATHS.inventory);
  const previousMetrics = parse(metricsBytes, PATHS.metrics);
  const previousApplicability = parse(applicabilityBytes, PATHS.applicability);
  const { row, receipt } = activeLockedSeoulTransferRow(ledger);
  const descriptorPath = `tools/datapack/sources/${row.snapshotId}.json`;
  const descriptorBytes = await read(descriptorPath);
  const previousDescriptor = parse(descriptorBytes, descriptorPath);
  assertAdmissionIdentity({ inventory, row, descriptor: previousDescriptor, descriptorBytes, descriptorPath, metrics: previousMetrics, applicability: previousApplicability });

  const retentionExpiresMillis = Date.parse(receipt.rawRetentionExpiresAt);
  const shouldRefreshRetention = refreshRetentionIfNeeded === true && (retentionExpiresMillis - now.valueOf()) <= RETENTION_REFRESH_WINDOW_MS;
  if (!shouldRefreshRetention && now.valueOf() >= retentionExpiresMillis) {
    throw new Error("TRANSFER raw retention has expired");
  }

  const parBaseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const storage = client ?? preauthenticatedObjectStorageClient(parBaseUrl, { includeErrorBody: false });
  const candidatesDocument = parse(sourceCandidatesBytes, PATHS.sourceCandidates);
  const canonicalPack = parse(packBytes, PATHS.canonicalPack);

  if (shouldRefreshRetention) {
    const resolvedOperationRoot = requiredAbsolute(operationRoot, "operation root");
    const [governancePolicyBytes, freshnessPolicyBytes] = await Promise.all([
      read(PATHS.governancePolicy),
      read(PATHS.freshnessPolicy),
    ]);
    const governancePolicy = parse(governancePolicyBytes, PATHS.governancePolicy);
    const freshnessPolicy = parse(freshnessPolicyBytes, PATHS.freshnessPolicy);
    const policySource = governancePolicy?.sources?.find(({ sourceId }) => sourceId === SOURCE_ID);
    const review = policySource?.licenseReview;
    if (typeof governancePolicy?.policyVersion !== "string" || !policySource || review?.status !== "APPROVED"
      || !(Date.parse(review.reviewedAt) <= now.valueOf() && now.valueOf() < Date.parse(review.nextReviewAt))) {
      throw new Error("TRANSFER governance or license is not current");
    }

    const runnerTemp = path.join(resolvedOperationRoot, `retention-${randomUUID()}`);
    await mkdir(runnerTemp, { recursive: true, mode: 0o700 });
    const observationDirectory = path.join(runnerTemp, "observation");
    const receiptPath = path.join(runnerTemp, "receipt.json");
    await collectSnapshot({ candidatesDocument, env, now, output: observationDirectory, runnerTemp });
    const observation = await readSeoulTransferObservationDirectory(observationDirectory, { sourceCandidatesBytes });
    const publishNow = new Date(Math.max(now.valueOf(), Date.parse(observation.manifest.capturedAt)));
    const nextReceipt = await publishRaw({
      observationDirectory,
      receiptPath,
      repositoryRoot: root,
      skipGitPreflight: true,
      env,
      client: storage,
      now: publishNow,
      sourceCandidatesBytes,
    });
    if (nextReceipt.snapshotId === row.snapshotId) {
      throw new Error("TRANSFER refreshed snapshotId collides with active head");
    }

    const metrics = rebuildAuthenticatedTransferTopologyMetrics({
      canonicalPack, canonicalPackBytes: packBytes, sourceCandidatesBytes, kricCatalogBytes: kricBytes,
      observation: {
        manifest: observation.manifest, observation: observation.observation, raw: observation.rawSnapshot,
        bytes: { manifest: observation.manifestBytes, observation: observation.observationBytes, raw: observation.rawBytes },
      },
    });
    assertOnlyBindingChanged(previousMetrics, metrics, eraseRefreshMetricsBinding, "TRANSFER metrics values");
    const nextMetricsBytes = lineBytes(metrics);
    const applicability = buildApplicability({ canonicalPack, canonicalPackBytes: packBytes, transferTopologyMetrics: metrics, metricsBytes: nextMetricsBytes });
    assertOnlyBindingChanged(previousApplicability, applicability, eraseRefreshApplicabilityBinding, "TRANSFER applicability values");
    const nextApplicabilityBytes = lineBytes(applicability);
    const descriptor = registerSeoulTransferSourceSnapshot({
      observation: { manifest: observation.manifest, manifestBytes: observation.manifestBytes, observationBytes: observation.observationBytes, rawBytes: observation.rawBytes },
      receipt: nextReceipt, metrics, metricsBytes: nextMetricsBytes, applicability, applicabilityBytes: nextApplicabilityBytes, now: new Date(nextReceipt.storedAt),
    });
    assertOnlyBindingChanged(previousDescriptor, descriptor, eraseRefreshDescriptorBinding, "TRANSFER descriptor values");
    const nextDescriptorPath = `tools/datapack/sources/${descriptor.snapshotId}.json`;
    const outputs = SEOUL_TRANSFER_REBIND_OUTPUTS(nextDescriptorPath);
    const nextDescriptorBytes = prettyBytes(descriptor);
    const approvedAt = publishNow.toISOString();
    const freshUntil = deriveFreshnessExpiresAt({
      policy: freshnessPolicy,
      sourceClassId: "annual_official_file",
      basisAt: descriptor.observedAt,
      evaluationAt: approvedAt,
    });

    const nextInventory = structuredClone(inventory);
    const nextSource = nextInventory.sources.find(({ id }) => id === SOURCE_ID);
    Object.assign(nextSource.transferAdmissionEvidence, {
      approvedAt,
      snapshotId: descriptor.snapshotId,
      snapshotPath: nextDescriptorPath,
      snapshotFileSha256: sha256(nextDescriptorBytes),
      capturedAt: descriptor.capturedAt,
      observedAt: descriptor.observedAt,
      freshUntil,
      rawSha256: descriptor.rawSha256,
      contentSha256: descriptor.contentSha256,
      schemaFingerprint: descriptor.schemaFingerprint,
      metricsArtifactSha256: metrics.artifactSha256,
      applicabilityArtifactSha256: applicability.artifactSha256,
    });
    const nextLedgerRow = {
      schemaVersion: 1,
      artifactKind: "official-source-snapshot",
      snapshotId: descriptor.snapshotId,
      sourceId: SOURCE_ID,
      provider: nextSource.provider,
      retrievedAt: descriptor.capturedAt,
      observedAt: descriptor.observedAt,
      sourceUpdatedAt: null,
      sourceEffectiveDate: descriptor.sourceEffectiveDate,
      rowCount: descriptor.rowCount,
      coverageCount: descriptor.transferTopology.directedMetricCount,
      rawSha256: descriptor.rawSha256,
      contentSha256: descriptor.contentSha256,
      rawObjectUri: nextReceipt.rawObjectUri,
      redactedRequestFingerprint: descriptor.observationIdentity.sourceCandidateSha256,
      schemaFingerprint: descriptor.schemaFingerprint,
      snapshotStatus: "LOCKED",
      schemaStatus: "PASS",
      licenseStatus: "PASS",
      fetchStatus: "SUCCESS",
      redistributionAllowed: true,
      credentialRedacted: true,
      previousSnapshotId: row.snapshotId,
      diffSummary: null,
      freshnessExpiresAt: freshUntil,
      rawRetentionExpiresAt: nextReceipt.rawRetentionExpiresAt,
      adminReviewRecordHash: row.adminReviewRecordHash,
      governancePolicyVersion: governancePolicy.policyVersion,
      governancePolicySha256: sha256(governancePolicyBytes),
      rawReceipt: nextReceipt,
      transferTopology: descriptor.transferTopology,
    };
    nextLedgerRow.diffSummary = buildSnapshotDiff(row, nextLedgerRow);
    const nextLedger = [...ledger, nextLedgerRow];

    const bytes = new Map([
      [PATHS.metrics, [metricsBytes, nextMetricsBytes]],
      [PATHS.applicability, [applicabilityBytes, nextApplicabilityBytes]],
      [nextDescriptorPath, [null, nextDescriptorBytes]],
      [PATHS.inventory, [inventoryBytes, prettyBytes(nextInventory)]],
      [PATHS.ledger, [ledgerBytes, prettyBytes(nextLedger)]],
    ]);
    return {
      outputs: outputs.map((relative) => ({ relative, prestate: bytes.get(relative)[0], bytes: bytes.get(relative)[1] })),
      previousCanonicalPackSha256: previousMetrics.canonicalIdentity?.canonicalPackSha256,
      canonicalPackSha256: sha256(packBytes),
      metricsArtifactSha256: metrics.artifactSha256,
      applicabilityArtifactSha256: applicability.artifactSha256,
    };
  }

  const outputs = SEOUL_TRANSFER_REBIND_OUTPUTS(descriptorPath);
  const rawBytes = await readLockedRaw({ client: storage, receipt, parBaseUrl });
  const observation = await reconstructSeoulTransferObservationFromRawSnapshot({ rawBytes, receipt, candidatesDocument });

  const metrics = rebuildAuthenticatedTransferTopologyMetrics({
    canonicalPack, canonicalPackBytes: packBytes, sourceCandidatesBytes, kricCatalogBytes: kricBytes,
    observation: {
      manifest: observation.manifest, observation: observation.observation, raw: observation.rawSnapshot,
      bytes: { manifest: observation.manifestBytes, observation: observation.observationBytes, raw: observation.rawBytes },
    },
  });
  assertOnlyBindingChanged(previousMetrics, metrics, eraseMetricsBinding, "TRANSFER metrics values");
  const nextMetricsBytes = lineBytes(metrics);
  const applicability = buildApplicability({ canonicalPack, canonicalPackBytes: packBytes, transferTopologyMetrics: metrics, metricsBytes: nextMetricsBytes });
  assertOnlyBindingChanged(previousApplicability, applicability, eraseApplicabilityBinding, "TRANSFER applicability values");
  const nextApplicabilityBytes = lineBytes(applicability);
  const descriptor = registerSeoulTransferSourceSnapshot({
    observation: { manifest: observation.manifest, manifestBytes: observation.manifestBytes, observationBytes: observation.observationBytes, rawBytes: observation.rawBytes },
    receipt, metrics, metricsBytes: nextMetricsBytes, applicability, applicabilityBytes: nextApplicabilityBytes, now: new Date(receipt.storedAt),
  });
  assertOnlyBindingChanged(previousDescriptor, descriptor, eraseDescriptorBinding, "TRANSFER descriptor values");
  const nextDescriptorBytes = prettyBytes(descriptor);

  const nextInventory = structuredClone(inventory);
  Object.assign(nextInventory.sources.find(({ id }) => id === SOURCE_ID).transferAdmissionEvidence, {
    metricsArtifactSha256: metrics.artifactSha256,
    applicabilityArtifactSha256: applicability.artifactSha256,
    snapshotFileSha256: sha256(nextDescriptorBytes),
  });
  const nextLedger = structuredClone(ledger);
  nextLedger[ledger.indexOf(row)].transferTopology = descriptor.transferTopology;

  const bytes = new Map([
    [PATHS.metrics, [metricsBytes, nextMetricsBytes]],
    [PATHS.applicability, [applicabilityBytes, nextApplicabilityBytes]],
    [descriptorPath, [descriptorBytes, nextDescriptorBytes]],
    [PATHS.inventory, [inventoryBytes, prettyBytes(nextInventory)]],
    [PATHS.ledger, [ledgerBytes, prettyBytes(nextLedger)]],
  ]);
  return {
    outputs: outputs.map((relative) => ({ relative, prestate: bytes.get(relative)[0], bytes: bytes.get(relative)[1] })),
    previousCanonicalPackSha256: previousMetrics.canonicalIdentity?.canonicalPackSha256,
    canonicalPackSha256: sha256(packBytes),
    metricsArtifactSha256: metrics.artifactSha256,
    applicabilityArtifactSha256: applicability.artifactSha256,
  };
}

async function assertAbsent(file, relative) {
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`TRANSFER output drift before commit: ${relative}`);
}

async function compareAndSwap(root, { relative, prestate, bytes }) {
  const file = path.join(root, relative);
  if (bytes === null) {
    if (!(await stableBytes(file, relative)).equals(prestate)) throw new Error(`TRANSFER output drift before commit: ${relative}`);
    await unlink(file);
    return;
  }
  if (prestate === null) await assertAbsent(file, relative);
  else if (!(await stableBytes(file, relative)).equals(prestate)) throw new Error(`TRANSFER output drift before commit: ${relative}`);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (prestate === null) {
      await assertAbsent(file, relative);
      await link(temporary, file);
      await unlink(temporary);
    } else {
      if (!(await stableBytes(file, relative)).equals(prestate)) throw new Error(`TRANSFER output drift before commit: ${relative}`);
      await rename(temporary, file);
    }
  } finally { await unlink(temporary).catch(() => {}); }
}

// beforeOutputWrite는 각 CAS 직전에 불린다(기본 no-op). 테스트가 동시 외부 쓰기(drift)를 재현할 때만 쓴다.
export async function rebindCurrentSeoulTransferSourceAdmission(options = {}) {
  const root = requiredAbsolute(options.repositoryRoot ?? ROOT, "repository root");
  const beforeOutputWrite = options.beforeOutputWrite ?? (async () => {});
  const derived = await deriveCurrentSeoulTransferSourceAdmissionOutputs({ ...options, repositoryRoot: root });
  const targets = derived.outputs.map(({ relative }) => relative);
  const summary = {
    targets, previousCanonicalPackSha256: derived.previousCanonicalPackSha256, canonicalPackSha256: derived.canonicalPackSha256,
    metricsArtifactSha256: derived.metricsArtifactSha256, applicabilityArtifactSha256: derived.applicabilityArtifactSha256,
  };
  const pending = derived.outputs.filter(({ prestate, bytes }) => prestate === null || !prestate.equals(bytes));
  if (pending.length === 0) return { ...summary, changed: false };
  const written = [];
  try {
    for (const output of pending) {
      await beforeOutputWrite({ relative: output.relative, phase: "commit" });
      await compareAndSwap(root, output);
      written.push(output);
    }
  } catch (error) {
    // 이미 쓴 출력만 실행 전 바이트로 되돌린다. 되돌리기도 실패하면 두 오류를 함께 드러낸다.
    try {
      for (const output of written.reverse()) {
        await beforeOutputWrite({ relative: output.relative, phase: "rollback" });
        await compareAndSwap(root, { relative: output.relative, prestate: output.bytes, bytes: output.prestate });
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "TRANSFER re-binding failed and rollback did not complete");
    }
    throw error;
  }
  return { ...summary, changed: true };
}

export function parseSeoulTransferRebindArgs(argv) {
  const usage = "arguments must be --repository-root <absolute> [--refresh-retention-if-needed --operation-root <absolute>]";
  if (!Array.isArray(argv) || argv[0] !== "--repository-root" || typeof argv[1] !== "string" || !path.isAbsolute(argv[1])) {
    throw new Error(usage);
  }
  if (argv.length === 2) return { repositoryRoot: path.resolve(argv[1]) };
  if (argv.length === 5 && argv[2] === "--refresh-retention-if-needed" && argv[3] === "--operation-root"
    && typeof argv[4] === "string" && path.isAbsolute(argv[4])) {
    return { repositoryRoot: path.resolve(argv[1]), refreshRetentionIfNeeded: true, operationRoot: path.resolve(argv[4]) };
  }
  throw new Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve()
    .then(() => rebindCurrentSeoulTransferSourceAdmission(parseSeoulTransferRebindArgs(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify({ result: "PASS", ...result })}\n`))
    .catch((error) => { process.stderr.write(`TRANSFER re-binding failed: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exitCode = 1; });
}
