// ITX-청춘 원천 승격 권한(#977). coverage contract의 sourceTimetableArtifact.promotion이 어떤 근거로 승격됐는지를 한 곳에서 판정한다.
// - CURRENT_CANDIDATE_OWNER_APPROVED: 이슈 #96·#636의 QA 승인 코멘트(approvalUrl)와 승인한 후보 sha256.
// - CURRENT_CANDIDATE_GATE_PASSED: 자동 이상 판정 게이트(itx-promotion-gate-v1)가 통과시킨 후보. 승인 코멘트가 없다.
//   근거는 원천 파일 옆에 커밋된 게이트 영수증이다. 영수증의 지표 check는 두 원천 파일에서 다시 계산해 대조할 수 있다.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import { ITX_PROMOTION_GATE_POLICY_ID, evaluateItxPromotionCommittedChecks, evaluateItxPromotionMetricChecks, parseItxPromotionGatePolicy } from "../itx-promotion-gate.mjs";
import { buildSnapshotDiff, requiredCredentialFreeObjectUri, validateLineage } from "../source-snapshot-policy.mjs";

export const ITX_SOURCE_ID = "itx-cheongchun-source-timetable";
export const ITX_SNAPSHOT_LEDGER_RELATIVE_PATH = "tools/datapack/release/source-snapshots.json";
export const ITX_PROMOTION_MODE_OWNER_APPROVED = "CURRENT_CANDIDATE_OWNER_APPROVED";
export const ITX_PROMOTION_MODE_GATE_PASSED = "CURRENT_CANDIDATE_GATE_PASSED";
const APPROVAL_URL = /^https:\/\/github\.com\/AquilaXk\/easysubway-data\/issues\/(?:96|636)#issuecomment-[1-9][0-9]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_PATH = /^tools\/datapack\/sources\/itx-cheongchun-source-timetable-\d{17}\.json$/u;
const ITX_RAW_STORAGE_BUCKET_URI = "oci://easysubway-source-raw";
const ITX_PROVIDER_REDACTED_URL = "https://apis.data.go.kr/B551457/run/v2/travelerTrainRunPlan2";
const ITX_SCHEMA_FINGERPRINT = createHash("sha256").update("itx-cheongchun-source-timetable-snapshot:v1").digest("hex");

// #981 이전(#977·#979)에 커밋된 게이트 승격 스냅샷 7건의 고정 해시(원장 결속 도입 전 이력).
// 원장에 ITX 원천이 아직 없을 때만 이 고정 집합을 허용하며, 이후 새 게이트 승격은 모두 원장 행이 있어야 한다.
const PRE_LEDGER_ITX_GATE_SNAPSHOTS = new Map([
  ["itx-cheongchun-source-timetable-20261010151222895", {
    sha256: "0126ba241e0975e7cb3c292c3def245c7c8c78228a811610052fa2d46f8acb5a",
    rawCaptureSha256: "f0b86b2841eb24ee30a3024c0772d04c1ce42f2e363f88ada9e29dccfdd1d698",
  }],
  ["itx-cheongchun-source-timetable-20261016200049829", {
    sha256: "5f60786cbcc18b671b347390e6191af573dce3b4d95c5050091d2e53570c5e16",
    rawCaptureSha256: "ae696ea39a2458b725b2df521b5a18080e74b6548aad482485e72a15d987c93d",
  }],
  ["itx-cheongchun-source-timetable-20261017150040720", {
    sha256: "ef80cdb88bdbbcff2dd2c2867c501b10573c03d19ba2956f8193a8007b2af32b",
    rawCaptureSha256: "1fdb7c16b60db4d9afb5b9bbe21b40724bf60d43ce094f752539872b67deb313",
  }],
  ["itx-cheongchun-source-timetable-20261026150051282", {
    sha256: "cf5c45a5bd6440cabb608310024dddc503c013ef43799930ef47fb1206851f39",
    rawCaptureSha256: "3ed9b9bbcf2019aaebf9165b4aef9868655f768aad884db2a303b7f998267101",
  }],
  ["itx-cheongchun-source-timetable-20261105001802000", {
    sha256: "b491df9530eb533b4ff83256ceade7b855c1d31e3ea356dd696bdc577604c050",
    rawCaptureSha256: "83fa5322fdf04bb43bf817e383f3b6370e0caa3dc5e90792362c3f121999d37e",
  }],
  ["itx-cheongchun-source-timetable-20261106150038097", {
    sha256: "86d1c9a4d5e48a45ea0dad69cf73b4cdc7f9803b21f2eeda9ac4f6cefb3a67a5",
    rawCaptureSha256: "eebff08e1bc7f1cb67e5edbb5cc0bb4d8ba723a28ea0d30d58636abaced4765b",
  }],
  ["itx-cheongchun-source-timetable-20261107174307877", {
    sha256: "b066e0a826a721694e20eb75cf81d50493c5b09033a8fd689c8ab3c77949b318",
    rawCaptureSha256: "d73db8d22626d00c4a74727d32e8b9f32b96ae34faeac3215d43493a8516a694",
  }],
]);

const sameKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort(codepointCompare)) === JSON.stringify([...keys].sort(codepointCompare));

export function itxPromotionReceiptPath(artifactId) {
  return `tools/datapack/sources/${artifactId}-promotion-gate.json`;
}

export function isCurrentItxPromotionMode(mode) {
  return mode === ITX_PROMOTION_MODE_OWNER_APPROVED || mode === ITX_PROMOTION_MODE_GATE_PASSED;
}

/** 승격 근거의 구조 검증. 승인 모드는 승인 코멘트 URL·승인 sha, 게이트 모드는 게이트 식별·영수증 경로를 정확히 가져야 한다. */
export function hasCurrentItxPromotionIdentity(reference) {
  const promotion = reference?.promotion;
  if (promotion?.mode === ITX_PROMOTION_MODE_OWNER_APPROVED) {
    return APPROVAL_URL.test(promotion.approvalUrl ?? "") && promotion.approvedArtifactSha256 === reference.sha256
      && !Object.hasOwn(promotion, "gate");
  }
  if (promotion?.mode === ITX_PROMOTION_MODE_GATE_PASSED) {
    return sameKeys(promotion, ["baselineArtifactPath", "baselineArtifactSha256", "gate", "gatedArtifactSha256", "mode", "previousArtifactPath", "previousArtifactSha256"])
      && promotion.gatedArtifactSha256 === reference.sha256
      && SHA256.test(promotion.previousArtifactSha256 ?? "")
      && SOURCE_PATH.test(promotion.previousArtifactPath ?? "")
      && SHA256.test(promotion.baselineArtifactSha256 ?? "")
      && SOURCE_PATH.test(promotion.baselineArtifactPath ?? "")
      && sameKeys(promotion.gate, ["policyId", "receiptPath", "receiptSha256"])
      && promotion.gate.policyId === ITX_PROMOTION_GATE_POLICY_ID
      && promotion.gate.receiptPath === itxPromotionReceiptPath(reference.artifactId)
      && SHA256.test(promotion.gate.receiptSha256 ?? "");
  }
  return false;
}

const POLICY_RELATIVE_PATH = "tools/datapack/itx-promotion-gate-policy.json";

function readTrackedFile(repositoryRoot, relativePath) {
  if (path.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath
    || !(relativePath.startsWith("tools/datapack/sources/")
      || relativePath === POLICY_RELATIVE_PATH
      || relativePath === ITX_SNAPSHOT_LEDGER_RELATIVE_PATH)) {
    throw new Error("ITX_PROMOTION_RECEIPT_PATH_INVALID");
  }
  const file = path.join(repositoryRoot, ...relativePath.split("/"));
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("ITX_PROMOTION_RECEIPT_PATH_INVALID");
  return readFileSync(file);
}

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(codepointCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function expectedItxRawObjectKey(observedAt, rawCaptureSha256) {
  const dateStamp = typeof observedAt === "string" ? observedAt.slice(0, 10).replaceAll("-", "") : "";
  if (!/^\d{8}$/u.test(dateStamp) || !SHA256.test(rawCaptureSha256 ?? "")) {
    throw new Error("ITX_PROMOTION_GATE_RAW_CAPTURE_LEDGER_MISMATCH");
  }
  return `source-raw/${ITX_SOURCE_ID}/${dateStamp}/${rawCaptureSha256}.json`;
}

export function expectedItxRawObjectUri(observedAt, rawCaptureSha256) {
  return requiredCredentialFreeObjectUri(`${ITX_RAW_STORAGE_BUCKET_URI}/${expectedItxRawObjectKey(observedAt, rawCaptureSha256)}`);
}

export function itxCandidateLedgerCounts(candidate) {
  const days = Array.isArray(candidate?.normalizedSnapshotSets) ? candidate.normalizedSnapshotSets : [];
  let rowCount = 0;
  let coverageCount = 0;
  for (const day of days) {
    rowCount += Array.isArray(day?.sets?.timetableTupleSet) ? day.sets.timetableTupleSet.length : 0;
    coverageCount += (Array.isArray(day?.sets?.stationSet) ? day.sets.stationSet.length : 0)
      + (Array.isArray(day?.sets?.odSet) ? day.sets.odSet.length : 0);
  }
  return { rowCount, coverageCount };
}

export function buildItxPromotionLedgerRow({
  snapshots = [],
  candidate,
  candidateSha256,
  receipt,
  rawByteSize,
  storedAt = candidate?.observedAt,
  rawObjectUri = null,
}) {
  if (!Array.isArray(snapshots) || !SHA256.test(candidateSha256 ?? "")
    || !SHA256.test(receipt?.source?.rawCaptureSha256 ?? "")
    || !SHA256.test(receipt?.source?.captureContentSha256 ?? "")
    || !Number.isSafeInteger(rawByteSize) || rawByteSize <= 0) {
    throw new Error("ITX_PROMOTION_GATE_RAW_CAPTURE_LEDGER_MISMATCH");
  }
  const byId = new Map(snapshots.map((row) => [row?.snapshotId, row]));
  const lineage = snapshots.length > 0 ? validateLineage(snapshots) : { headsBySource: {} };
  const previousHeadId = lineage.headsBySource[ITX_SOURCE_ID] ?? null;
  const previousRow = previousHeadId === null ? null : byId.get(previousHeadId);
  if (previousHeadId !== null && (!previousRow
    || previousRow.snapshotId !== receipt?.previous?.artifactId
    || previousRow.contentSha256 !== receipt?.previous?.sha256)) {
    throw new Error("ITX_PROMOTION_GATE_RAW_CAPTURE_LEDGER_MISMATCH");
  }
  const rawCaptureSha256 = receipt.source.rawCaptureSha256;
  const resolvedUri = requiredCredentialFreeObjectUri(rawObjectUri ?? expectedItxRawObjectUri(candidate?.observedAt, rawCaptureSha256));
  const { rowCount, coverageCount } = itxCandidateLedgerCounts(candidate);
  const nextRow = {
    sourceId: ITX_SOURCE_ID,
    snapshotId: candidate.artifactId,
    previousSnapshotId: previousHeadId,
    retrievedAt: candidate.observedAt,
    sourceUpdatedAt: candidate.observedAt,
    freshnessExpiresAt: new Date(Date.parse(candidate.freshUntil)).toISOString(),
    fetchStatus: "SUCCESS",
    httpStatus: 200,
    rawObjectUri: resolvedUri,
    rawSha256: rawCaptureSha256,
    rawObjectSha256: rawCaptureSha256,
    contentSha256: candidateSha256,
    rowCount,
    coverageCount,
    schemaFingerprint: ITX_SCHEMA_FINGERPRINT,
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    redistributionAllowed: true,
    credentialRedacted: true,
    redactedRequestFingerprint: receipt.source.captureContentSha256,
    diffSummary: null,
    rawReceipt: {
      receiptVersion: 1,
      sourceId: ITX_SOURCE_ID,
      snapshotId: candidate.artifactId,
      capturedAt: candidate.observedAt,
      storedAt,
      rawObjectUri: resolvedUri,
      rawObjectSha256: rawCaptureSha256,
      snapshotRawSha256: rawCaptureSha256,
      snapshotFileSha256: candidateSha256,
      byteSize: rawByteSize,
      contentType: "application/json",
      storageMode: "OBJECT_STORAGE_PREAUTH",
      immutableWriteVerified: true,
      redactedRequestUrl: ITX_PROVIDER_REDACTED_URL,
    },
    snapshotStatus: "LOCKED",
  };
  if (previousRow !== null) {
    nextRow.diffSummary = buildSnapshotDiff(previousRow, nextRow);
  }
  validateLineage([...snapshots, nextRow]);
  return nextRow;
}

export function appendItxPromotionLedgerRow(options) {
  const nextRow = buildItxPromotionLedgerRow(options);
  return [...(options?.snapshots ?? []), nextRow];
}

function verifyItxRawCaptureLedgerBinding({ repositoryRoot, reference, receipt, candidate }) {
  let snapshots;
  try {
    snapshots = JSON.parse(readTrackedFile(repositoryRoot, ITX_SNAPSHOT_LEDGER_RELATIVE_PATH));
  } catch (error) {
    throw new Error("ITX_PROMOTION_GATE_RAW_CAPTURE_LEDGER_MISSING", { cause: error });
  }
  if (!Array.isArray(snapshots)) throw new Error("ITX_PROMOTION_GATE_RAW_CAPTURE_LEDGER_MISMATCH");
  const ledgerById = new Map(snapshots.map((row) => [row?.snapshotId, row]));
  let lineage = { headsBySource: {} };
  if (snapshots.length > 0) {
    try {
      lineage = validateLineage(snapshots);
    } catch (error) {
      throw new Error("ITX_PROMOTION_GATE_RAW_CAPTURE_LEDGER_MISMATCH", { cause: error });
    }
  }
  const ledgerRow = ledgerById.get(reference.artifactId);
  if (!ledgerRow) {
    const preLedger = PRE_LEDGER_ITX_GATE_SNAPSHOTS.get(reference.artifactId);
    if (preLedger
      && preLedger.sha256 === reference.sha256
      && preLedger.rawCaptureSha256 === receipt.source.rawCaptureSha256
      && !Object.hasOwn(lineage.headsBySource, ITX_SOURCE_ID)) {
      return;
    }
    throw new Error("ITX_PROMOTION_GATE_RAW_CAPTURE_LEDGER_MISSING");
  }
  const { rowCount, coverageCount } = itxCandidateLedgerCounts(candidate);
  const expectedUri = expectedItxRawObjectUri(receipt.candidate.observedAt, receipt.source.rawCaptureSha256);
  const rawReceipt = ledgerRow.rawReceipt;
  if (lineage.headsBySource[ITX_SOURCE_ID] !== reference.artifactId
    || ledgerRow.sourceId !== ITX_SOURCE_ID
    || ledgerRow.snapshotId !== reference.artifactId
    || ledgerRow.snapshotStatus !== "LOCKED"
    || ledgerRow.fetchStatus !== "SUCCESS"
    || ledgerRow.httpStatus !== 200
    || ledgerRow.schemaStatus !== "PASS"
    || ledgerRow.licenseStatus !== "PASS"
    || ledgerRow.redistributionAllowed !== true
    || ledgerRow.credentialRedacted !== true
    || ledgerRow.retrievedAt !== receipt.candidate.observedAt
    || ledgerRow.sourceUpdatedAt !== receipt.candidate.observedAt
    || ledgerRow.freshnessExpiresAt !== new Date(Date.parse(receipt.candidate.freshUntil)).toISOString()
    || ledgerRow.rawSha256 !== receipt.source.rawCaptureSha256
    || ledgerRow.rawObjectSha256 !== receipt.source.rawCaptureSha256
    || ledgerRow.contentSha256 !== reference.sha256
    || ledgerRow.rowCount !== rowCount
    || ledgerRow.coverageCount !== coverageCount
    || ledgerRow.redactedRequestFingerprint !== receipt.source.captureContentSha256
    || ledgerRow.rawObjectUri !== expectedUri
    || !(ledgerRow.previousSnapshotId === null || ledgerRow.previousSnapshotId === receipt.previous.artifactId)
    || rawReceipt?.sourceId !== ITX_SOURCE_ID
    || rawReceipt?.snapshotId !== reference.artifactId
    || rawReceipt?.capturedAt !== receipt.candidate.observedAt
    || rawReceipt?.rawObjectUri !== expectedUri
    || rawReceipt?.rawObjectSha256 !== receipt.source.rawCaptureSha256
    || rawReceipt?.snapshotRawSha256 !== receipt.source.rawCaptureSha256
    || rawReceipt?.snapshotFileSha256 !== reference.sha256
    || rawReceipt?.immutableWriteVerified !== true
    || !Number.isSafeInteger(rawReceipt?.byteSize)
    || rawReceipt.byteSize <= 0) {
    throw new Error("ITX_PROMOTION_GATE_RAW_CAPTURE_LEDGER_MISMATCH");
  }
}

/** 원천 파일을 읽어 sha256이 맞는지 확인하고 본문을 돌려준다. 경로는 sources 디렉터리 안의 일반 파일이어야 한다. */
export function readTrackedItxSource({ repositoryRoot, relativePath, sha256: expected }) {
  const bytes = readTrackedFile(repositoryRoot, relativePath);
  if (sha256Of(bytes) !== expected) throw new Error("ITX_PROMOTION_SOURCE_SHA256_MISMATCH");
  return bytes.toString("utf8");
}

/**
 * 게이트 모드 승격이 커밋된 증거로 성립하는지 다시 확인한다. 소비자(build-datapack 등)와 CI가 같은 함수를 부른다.
 * - 정책은 영수증에 적힌 값을 믿지 않는다. 커밋된 정책 파일을 읽어 영수증의 정책과 같아야 하고, 그 정책으로 다시 계산한다.
 * - 영수증 파일 sha·PASS·후보·직전·기준선 결속을 보고, 지표(직전·기준선 대비)와 커밋된 완전성 증거로 계산하는 결속·수집 오류 check를 원천 파일에서 다시 계산해 대조한다.
 * - raw capture·replay에 의존하는 check(SOURCE_BINDING·FETCH_ERRORS)는 영수증의 PASS와 raw capture sha 형식을 확인하고,
 *   원장(tools/datapack/release/source-snapshots.json)에 등록된 ITX 스냅샷 행의 rawSha256·rawObjectSha256·contentSha256·rawObjectUri·rawReceipt와 대조한다(#981).
 */
export function verifyItxGatePromotion({ reference, repositoryRoot }) {
  if (!hasCurrentItxPromotionIdentity(reference) || reference.promotion.mode !== ITX_PROMOTION_MODE_GATE_PASSED) {
    throw new Error("ITX_PROMOTION_GATE_IDENTITY_INVALID");
  }
  const { gate, previousArtifactPath, previousArtifactSha256, baselineArtifactPath, baselineArtifactSha256 } = reference.promotion;
  const receiptBytes = readTrackedFile(repositoryRoot, gate.receiptPath);
  if (sha256Of(receiptBytes) !== gate.receiptSha256) throw new Error("ITX_PROMOTION_RECEIPT_SHA256_MISMATCH");
  const receipt = JSON.parse(receiptBytes);
  if (receiptBytes.toString("utf8") !== `${JSON.stringify(receipt, null, 2)}\n`) throw new Error("ITX_PROMOTION_RECEIPT_NOT_CANONICAL");
  if (receipt.artifactKind !== "itx-promotion-gate-receipt" || receipt.schemaVersion !== 1
    || receipt.policyId !== gate.policyId || receipt.status !== "PASS"
    || !Array.isArray(receipt.blockedCheckIds) || receipt.blockedCheckIds.length !== 0 || !Array.isArray(receipt.checks)
    || receipt.candidate?.artifactId !== reference.artifactId || receipt.candidate?.sha256 !== reference.sha256
    || receipt.candidate?.freshUntil !== reference.freshUntil
    || receipt.previous?.sha256 !== previousArtifactSha256
    || receipt.baseline?.sha256 !== baselineArtifactSha256) {
    throw new Error("ITX_PROMOTION_RECEIPT_IDENTITY_INVALID");
  }
  // 영수증이 스스로 적은 정책(한도)으로 판정받지 못하게, 커밋된 정책과 같은지 강제한다.
  const policy = parseItxPromotionGatePolicy(JSON.parse(readTrackedFile(repositoryRoot, POLICY_RELATIVE_PATH)));
  if (canonicalJson(parseItxPromotionGatePolicy(receipt.policy)) !== canonicalJson(policy)) throw new Error("ITX_PROMOTION_RECEIPT_POLICY_MISMATCH");
  const candidateBytes = readTrackedFile(repositoryRoot, reference.artifactPath);
  const previousBytes = readTrackedFile(repositoryRoot, previousArtifactPath);
  const baselineBytes = baselineArtifactSha256 === previousArtifactSha256 ? previousBytes : readTrackedFile(repositoryRoot, baselineArtifactPath);
  const completenessBytes = readTrackedFile(repositoryRoot, reference.completenessEvidencePath);
  if (sha256Of(candidateBytes) !== reference.sha256 || sha256Of(previousBytes) !== previousArtifactSha256
    || sha256Of(baselineBytes) !== baselineArtifactSha256 || sha256Of(completenessBytes) !== reference.completenessEvidenceSha256) {
    throw new Error("ITX_PROMOTION_SOURCE_SHA256_MISMATCH");
  }
  const candidate = JSON.parse(candidateBytes);
  const recomputed = [
    ...evaluateItxPromotionMetricChecks({
      policy,
      candidate,
      previous: JSON.parse(previousBytes),
      previousSha256: previousArtifactSha256,
      baseline: JSON.parse(baselineBytes),
      baselineSha256: baselineArtifactSha256,
    }),
    ...evaluateItxPromotionCommittedChecks({
      policy, candidate, candidateSha256: reference.sha256, completeness: JSON.parse(completenessBytes), completenessSha256: reference.completenessEvidenceSha256,
    }),
  ];
  const recordedIds = new Set(recomputed.map(({ id }) => id));
  const recorded = receipt.checks.filter(({ id }) => recordedIds.has(id));
  if (canonicalJson(recorded) !== canonicalJson(recomputed) || recomputed.some(({ status }) => status !== "PASS")) {
    throw new Error("ITX_PROMOTION_RECEIPT_METRICS_MISMATCH");
  }
  for (const id of ["SOURCE_BINDING", "FETCH_ERRORS"]) {
    const raw = receipt.checks.filter((item) => item?.id === id);
    if (raw.length !== 1 || raw[0].status !== "PASS") throw new Error("ITX_PROMOTION_RECEIPT_RAW_CHECK_INVALID");
  }
  if (!SHA256.test(receipt.source?.rawCaptureSha256 ?? "") || !SHA256.test(receipt.source?.captureContentSha256 ?? "")
    || !SHA256.test(receipt.source?.replayEvidenceHash ?? "")) {
    throw new Error("ITX_PROMOTION_RECEIPT_RAW_CHECK_INVALID");
  }
  verifyItxRawCaptureLedgerBinding({ repositoryRoot, reference, receipt, candidate });
  return receipt;
}

/** 승격 근거가 게이트 모드일 때만 재검증한다. 소비자가 같은 한 줄로 부른다. */
export function verifyCurrentItxPromotion({ reference, repositoryRoot }) {
  if (reference?.promotion?.mode !== ITX_PROMOTION_MODE_GATE_PASSED) return;
  if (typeof repositoryRoot !== "string" || repositoryRoot === "") throw new Error("ITX_PROMOTION_REPOSITORY_ROOT_REQUIRED");
  verifyItxGatePromotion({ reference, repositoryRoot });
}
