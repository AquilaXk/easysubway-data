// 소비자 테스트용: 저장소의 현재 승인 원천 파일을 임시 저장소 루트로 복사하고, 그 원천을 게이트 승격으로 승격한 것처럼
// 영수증·정책·contract를 만든다(후보=직전=기준선 = 같은 원천이라 모든 지표가 0이다). 영수증은 실제 게이트가 계산한다.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateItxPromotionGate, itxPromotionGateReceiptBytes, parseItxPromotionGatePolicy } from "../itx-promotion-gate.mjs";
import { itxPromotionReceiptPath } from "../lib/itx-promotion-authority.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function createGatedPromotionRoot({ policyOverride = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-gated-root-"));
  const contract = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const reference = contract.sourceTimetableArtifact;
  const copy = async (relativePath) => {
    const bytes = await readFile(path.join(repositoryRoot, relativePath));
    await mkdir(path.dirname(path.join(dir, relativePath)), { recursive: true });
    await writeFile(path.join(dir, relativePath), bytes);
    return bytes;
  };
  const sourceBytes = await copy(reference.artifactPath);
  const completenessBytes = await copy(reference.completenessEvidencePath);
  const policyBytes = await copy("tools/datapack/itx-promotion-gate-policy.json");
  const policy = parseItxPromotionGatePolicy(JSON.parse(policyBytes));
  const source = JSON.parse(sourceBytes);
  const completeness = JSON.parse(completenessBytes);
  const receipt = evaluateItxPromotionGate({
    policy: policyOverride ?? policy,
    candidate: source,
    candidateSha256: reference.sha256,
    completeness,
    completenessSha256: reference.completenessEvidenceSha256,
    previous: source,
    previousSha256: reference.sha256,
    baseline: source,
    baselineSha256: reference.sha256,
    capture: {
      artifactKind: "provider-response-capture",
      observedAt: source.observedAt,
      selectedServiceDates: source.selectedServiceDates,
      contentSha256: sha256("capture-content"),
      records: [{ index: 0, outcome: { kind: "RESPONSE", response: { status: 200 } } }],
    },
    captureSha256: sha256("capture-bytes"),
    replay: { ...completeness, validationMode: "REPLAY", evidenceHash: sha256("replay") },
  });
  if (receipt.status !== "PASS") throw new Error(`fixture receipt must pass: ${receipt.blockedCheckIds.join(",")}`);
  const receiptBytes = itxPromotionGateReceiptBytes(receipt);
  await writeFile(path.join(dir, itxPromotionReceiptPath(reference.artifactId)), receiptBytes);
  reference.promotion = {
    mode: "CURRENT_CANDIDATE_GATE_PASSED",
    previousArtifactPath: reference.artifactPath,
    previousArtifactSha256: reference.sha256,
    gate: { policyId: policy.policyId, receiptPath: itxPromotionReceiptPath(reference.artifactId), receiptSha256: sha256(receiptBytes) },
    gatedArtifactSha256: reference.sha256,
    baselineArtifactPath: reference.artifactPath,
    baselineArtifactSha256: reference.sha256,
  };
  const contractPath = path.join(dir, "tools/datapack/itx-cheongchun-coverage-contract.json");
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  return {
    root: dir,
    contract,
    contractPath,
    reference,
    receiptPath: path.join(dir, itxPromotionReceiptPath(reference.artifactId)),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
