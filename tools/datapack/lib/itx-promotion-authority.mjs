// ITX-청춘 원천 승격 권한(#977). coverage contract의 sourceTimetableArtifact.promotion이 어떤 근거로 승격됐는지를 한 곳에서 판정한다.
// - CURRENT_CANDIDATE_OWNER_APPROVED: 이슈 #96·#636의 QA 승인 코멘트(approvalUrl)와 승인한 후보 sha256.
// - CURRENT_CANDIDATE_GATE_PASSED: 자동 이상 판정 게이트(itx-promotion-gate-v1)가 통과시킨 후보. 승인 코멘트가 없다.
//   근거는 원천 파일 옆에 커밋된 게이트 영수증이다. 영수증의 지표 check는 두 원천 파일에서 다시 계산해 대조할 수 있다.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import { ITX_PROMOTION_GATE_POLICY_ID, evaluateItxPromotionCommittedChecks, evaluateItxPromotionMetricChecks, parseItxPromotionGatePolicy } from "../itx-promotion-gate.mjs";

export const ITX_PROMOTION_MODE_OWNER_APPROVED = "CURRENT_CANDIDATE_OWNER_APPROVED";
export const ITX_PROMOTION_MODE_GATE_PASSED = "CURRENT_CANDIDATE_GATE_PASSED";
const APPROVAL_URL = /^https:\/\/github\.com\/AquilaXk\/easysubway-data\/issues\/(?:96|636)#issuecomment-[1-9][0-9]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_PATH = /^tools\/datapack\/sources\/itx-cheongchun-source-timetable-\d{17}\.json$/u;

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
    || !(relativePath.startsWith("tools/datapack/sources/") || relativePath === POLICY_RELATIVE_PATH)) {
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
 * - raw capture·replay에 의존하는 check(SOURCE_BINDING·FETCH_ERRORS)는 저장소에 남지 않아 다시 계산할 수 없다. 영수증의 PASS와 raw capture sha 형식만 본다.
 *   그 sha를 원천 원장과 대조하려면 ITX raw capture가 원장에 등록돼 있어야 하는데 현재 원장에 ITX 원천이 없다(후속 이슈 범위).
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
  return receipt;
}

/** 승격 근거가 게이트 모드일 때만 재검증한다. 소비자가 같은 한 줄로 부른다. */
export function verifyCurrentItxPromotion({ reference, repositoryRoot }) {
  if (reference?.promotion?.mode !== ITX_PROMOTION_MODE_GATE_PASSED) return;
  if (typeof repositoryRoot !== "string" || repositoryRoot === "") throw new Error("ITX_PROMOTION_REPOSITORY_ROOT_REQUIRED");
  verifyItxGatePromotion({ reference, repositoryRoot });
}
