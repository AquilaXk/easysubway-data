// ITX-청춘 원천 승격 권한(#977). coverage contract의 sourceTimetableArtifact.promotion이 어떤 근거로 승격됐는지를 한 곳에서 판정한다.
// - CURRENT_CANDIDATE_OWNER_APPROVED: 이슈 #96·#636의 QA 승인 코멘트(approvalUrl)와 승인한 후보 sha256.
// - CURRENT_CANDIDATE_GATE_PASSED: 자동 이상 판정 게이트(itx-promotion-gate-v1)가 통과시킨 후보. 승인 코멘트가 없다.
//   근거는 원천 파일 옆에 커밋된 게이트 영수증이다. 영수증의 지표 check는 두 원천 파일에서 다시 계산해 대조할 수 있다.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import { ITX_PROMOTION_GATE_POLICY_ID, evaluateItxPromotionMetricChecks, parseItxPromotionGatePolicy } from "../itx-promotion-gate.mjs";

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

async function readTrackedFile(repositoryRoot, relativePath) {
  if (path.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath || !relativePath.startsWith("tools/datapack/sources/")) {
    throw new Error("ITX_PROMOTION_RECEIPT_PATH_INVALID");
  }
  const file = path.join(repositoryRoot, ...relativePath.split("/"));
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("ITX_PROMOTION_RECEIPT_PATH_INVALID");
  return readFile(file);
}

/** 원천 파일을 읽어 sha256이 맞는지 확인하고 본문을 돌려준다. 경로는 sources 디렉터리 안의 일반 파일이어야 한다. */
export async function readTrackedItxSource({ repositoryRoot, relativePath, sha256: expected }) {
  const bytes = await readTrackedFile(repositoryRoot, relativePath);
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("ITX_PROMOTION_SOURCE_SHA256_MISMATCH");
  return bytes.toString("utf8");
}

/**
 * 게이트 모드 승격이 커밋된 증거로 성립하는지 다시 확인한다(CI 계약 테스트용).
 * 영수증 파일 sha·PASS·후보·직전 원천 결속을 보고, 지표 check는 두 원천 파일에서 영수증에 담긴 정책으로 다시 계산해 같아야 한다.
 * 원천 결속·수집 오류 check는 보관되지 않는 raw capture에 의존하므로 영수증에 기록된 PASS와 그 sha 결속만 본다.
 */
export async function verifyItxGatePromotion({ reference, repositoryRoot }) {
  if (!hasCurrentItxPromotionIdentity(reference) || reference.promotion.mode !== ITX_PROMOTION_MODE_GATE_PASSED) {
    throw new Error("ITX_PROMOTION_GATE_IDENTITY_INVALID");
  }
  const { gate, previousArtifactPath, previousArtifactSha256, baselineArtifactPath, baselineArtifactSha256 } = reference.promotion;
  const receiptBytes = await readTrackedFile(repositoryRoot, gate.receiptPath);
  if (createHash("sha256").update(receiptBytes).digest("hex") !== gate.receiptSha256) throw new Error("ITX_PROMOTION_RECEIPT_SHA256_MISMATCH");
  const receipt = JSON.parse(receiptBytes);
  if (receiptBytes.toString("utf8") !== `${JSON.stringify(receipt, null, 2)}\n`) throw new Error("ITX_PROMOTION_RECEIPT_NOT_CANONICAL");
  if (receipt.artifactKind !== "itx-promotion-gate-receipt" || receipt.schemaVersion !== 1
    || receipt.policyId !== gate.policyId || receipt.status !== "PASS"
    || !Array.isArray(receipt.blockedCheckIds) || receipt.blockedCheckIds.length !== 0
    || receipt.candidate?.artifactId !== reference.artifactId || receipt.candidate?.sha256 !== reference.sha256
    || receipt.candidate?.freshUntil !== reference.freshUntil
    || receipt.previous?.sha256 !== previousArtifactSha256
    || receipt.baseline?.sha256 !== baselineArtifactSha256) {
    throw new Error("ITX_PROMOTION_RECEIPT_IDENTITY_INVALID");
  }
  const policy = parseItxPromotionGatePolicy(receipt.policy);
  const candidateBytes = await readTrackedFile(repositoryRoot, reference.artifactPath);
  const previousBytes = await readTrackedFile(repositoryRoot, previousArtifactPath);
  if (createHash("sha256").update(candidateBytes).digest("hex") !== reference.sha256
    || createHash("sha256").update(previousBytes).digest("hex") !== previousArtifactSha256) {
    throw new Error("ITX_PROMOTION_SOURCE_SHA256_MISMATCH");
  }
  const baselineBytes = baselineArtifactSha256 === previousArtifactSha256 ? previousBytes : await readTrackedFile(repositoryRoot, baselineArtifactPath);
  if (createHash("sha256").update(baselineBytes).digest("hex") !== baselineArtifactSha256) throw new Error("ITX_PROMOTION_SOURCE_SHA256_MISMATCH");
  const recomputed = evaluateItxPromotionMetricChecks({
    policy,
    candidate: JSON.parse(candidateBytes),
    previous: JSON.parse(previousBytes),
    previousSha256: previousArtifactSha256,
    baseline: JSON.parse(baselineBytes),
    baselineSha256: baselineArtifactSha256,
  });
  const recordedMetrics = receipt.checks.filter(({ id }) => recomputed.some((check) => check.id === id));
  if (JSON.stringify(recordedMetrics) !== JSON.stringify(recomputed) || recomputed.some(({ status }) => status !== "PASS")) {
    throw new Error("ITX_PROMOTION_RECEIPT_METRICS_MISMATCH");
  }
  return receipt;
}
